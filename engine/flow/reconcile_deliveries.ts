import type { AttributionTuple, DbConnection } from '../contract/types.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { notifyOperator } from '../state/notifications.ts';
import { getBranchTipCommit } from '../delivery/pr_create.ts';
import { getDeliveryGatingReview } from '../delivery/diff_review_gate.ts';
import { enqueueDeliveryFreshenIfAbsent } from '../delivery/freshen.ts';
import { WORK_REVIEW_DIFF_PHASE } from '../contract/constants.ts';

const SYSTEM_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'queue-policy',
  account: null
};

/**
 * How many times reconcileDeliveries may auto-enqueue a next-step for one task
 * before it stops and PARKS it (operator action). Bounds thrash when main keeps
 * moving under a branch or a delivery keeps failing.
 */
export const DELIVERY_RESUME_BUDGET = 3;

const NOT_MERGEABLE_RE = /is not mergeable|cannot be cleanly created/i;
const TRANSIENT_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|network|EAI_AGAIN|temporarily|rate limit/i;

interface DeadDelivery {
  kind: string;
  error: string;
}

function latestDeadDelivery(db: DbConnection, taskId: string): DeadDelivery | undefined {
  return db.get<DeadDelivery>(
    `SELECT kind, COALESCE(last_error,'') error FROM bureau_jobs
      WHERE task_id = ? AND kind IN ('pr.create','pr.merge','delivery.freshen','work.diff-review') AND state = 'dead'
      ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    taskId
  );
}

/** Count prior auto-resume enqueues for a task (the budget record). */
function resumeCount(db: DbConnection, taskId: string): number {
  const r = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_journal
      WHERE task_id = ? AND kind = 'system' AND json_extract(detail,'$.action') = 'delivery_resume'`,
    taskId
  );
  return r?.n ?? 0;
}

/** Journal a park-signal exactly ONCE per task+action (so a parked task doesn't
 *  spam the journal every sweep), then notify. Returns true if it journaled. */
function parkOnce(db: DbConnection, taskId: string, action: string, extra: Record<string, unknown>, note: string): boolean {
  const already = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_journal WHERE task_id = ? AND json_extract(detail,'$.action') = ?`,
    taskId,
    action
  );
  if ((already?.n ?? 0) > 0) return false;
  journal(db, { kind: 'guardrail', attribution: SYSTEM_ATTRIBUTION, taskId, detail: { action, ...extra } });
  notifyOperator(`delivery-resume:${taskId}`, note);
  return true;
}

/**
 * Restart-safe delivery resumption — the missing half of the queue manager.
 *
 * `reconcileQueuedTasks` only revives `queued -> plan.cycle`. An APPROVED task
 * whose delivery job DIED (dead = terminal) is otherwise stuck at needs-review
 * forever: nothing re-drives pr.create / pr.merge / the freshen recovery on
 * restart. This pass finds those tasks and enqueues the correct next step,
 * bounded + classified so it never thrashes and honors the "dead needs operator
 * action" policy for genuinely-broken deliveries. It NEVER transitions state
 * (needs-review -> blocked is illegal); a task it cannot auto-resume is PARKED
 * at needs-review with a one-time loud signal.
 *
 * @returns task ids for which a next-step was enqueued this sweep.
 */
export function reconcileDeliveries(db: DbConnection): string[] {
  const candidates = db.all<{ id: string; pull_request_url: string | null }>(
    `SELECT t.id, t.pull_request_url FROM bureau_tasks t
      WHERE t.state = 'needs-review'
        AND t.archived_at IS NULL
        AND t.merged_at IS NULL
        AND t.approved_at IS NOT NULL
        AND t.approved_by IS NOT NULL
        AND t.verifier_exit_code = 0
        AND NOT EXISTS (
          SELECT 1 FROM bureau_jobs j
          WHERE j.task_id = t.id
            AND j.kind IN ('pr.create','pr.merge','delivery.freshen','work.diff-review')
            AND j.state IN ('pending','running'))
      ORDER BY t.created_at ASC, t.id ASC`
  );

  const acted: string[] = [];
  for (const { id: taskId, pull_request_url } of candidates) {
    // Budget: stop thrashing; park for the operator.
    if (resumeCount(db, taskId) >= DELIVERY_RESUME_BUDGET) {
      parkOnce(
        db,
        taskId,
        'delivery_resume_exhausted',
        { budget: DELIVERY_RESUME_BUDGET },
        `Task ${taskId} delivery could not be auto-resumed after ${DELIVERY_RESUME_BUDGET} tries — parked at needs-review for manual delivery.`
      );
      continue;
    }

    // A latest AMEND diff-review owes a junior fix, not delivery.
    const latestPhase4 = db.get<{ verdict: string }>(
      `SELECT verdict FROM bureau_work_reviews WHERE task_id = ? AND phase = ? ORDER BY created_at DESC LIMIT 1`,
      taskId,
      WORK_REVIEW_DIFF_PHASE
    );
    if (latestPhase4?.verdict === 'amend') continue;

    let currentTip: string;
    try {
      currentTip = getBranchTipCommit(db, taskId);
    } catch {
      // Worktree/branch gone (pruned, or a lost non-dept branch) — not
      // auto-resumable; park once, leave for the operator.
      parkOnce(
        db,
        taskId,
        'delivery_resume_no_worktree',
        {},
        `Task ${taskId} has no live worktree/branch — cannot auto-resume delivery; archive or re-file.`
      );
      continue;
    }

    const gating = getDeliveryGatingReview(db, taskId);
    const dead = latestDeadDelivery(db, taskId);
    let action: string | null = null;
    let jobId: string | undefined;

    // Classify a dead delivery job FIRST — BEFORE the gate-at-tip shortcut. A
    // genuine not-mergeable corpse always has an approved phase4 gate standing at
    // the current tip (pr.merge exists only after pr.create, which required the
    // gate at tip; the conflict is with MAIN, so the branch tip never moved). If
    // we checked gate-at-tip first we would re-enqueue the guaranteed-to-fail
    // `gh pr merge` — the exact thrash PRs #9/#11 died on. Freshening is the fix.
    if (pull_request_url && dead && dead.kind === 'pr.merge' && NOT_MERGEABLE_RE.test(dead.error)) {
      // The classic conflict corpse — hand it to the freshen recovery. (Freshen
      // is a local, non-destructive git merge/abort, cheaply bounded by its own
      // budget — not a guaranteed-failing remote call.)
      jobId = enqueueDeliveryFreshenIfAbsent(db, taskId);
      action = 'delivery.freshen';
    } else if (dead && TRANSIENT_RE.test(dead.error)) {
      // A transient (network/gh) failure — retry the same delivery step.
      jobId = enqueueJob(db, { kind: dead.kind, task_id: taskId, payload: { taskId } }).id;
      action = `${dead.kind}(retry)`;
    } else if (dead && (dead.kind === 'pr.create' || dead.kind === 'pr.merge')) {
      // A hard, non-transient delivery error (e.g. the branch is gone) — the
      // "dead needs operator action" policy: do NOT auto-retry, park once.
      parkOnce(
        db,
        taskId,
        'delivery_resume_hard_error',
        { kind: dead.kind, error: dead.error.slice(0, 200) },
        `Task ${taskId} ${dead.kind} failed with a non-transient error — parked. Reason: ${dead.error.slice(0, 160)}`
      );
      continue;
    } else if (gating && gating.reviewed_commit === currentTip) {
      // Gate stands at the current tip and no recoverable dead job — create the
      // PR, or merge the open one.
      if (pull_request_url) {
        jobId = enqueueJob(db, { kind: 'pr.merge', task_id: taskId, payload: { taskId } }).id;
        action = 'pr.merge';
      } else {
        jobId = enqueueJob(db, { kind: 'pr.create', task_id: taskId, payload: { taskId } }).id;
        action = 'pr.create';
      }
    } else {
      // No gate at the tip and no recoverable dead job — (re)produce the phase4
      // gate at the tip.
      jobId = enqueueJob(db, { kind: 'work.diff-review', task_id: taskId, payload: { taskId } }).id;
      action = 'work.diff-review';
    }

    if (action && jobId !== undefined) {
      journal(db, {
        kind: 'system',
        attribution: SYSTEM_ATTRIBUTION,
        taskId,
        jobId,
        detail: { action: 'delivery_resume', next: action, tip: currentTip }
      });
      acted.push(taskId);
    }
  }
  return acted;
}
