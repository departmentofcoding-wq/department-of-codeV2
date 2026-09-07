import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { WORK_REVIEW_DIFF_PHASE } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { notifyOperator } from '../state/notifications.ts';
import { getSeniorDriver } from '../harness/senior-seam.ts';
import { assignSeniorForTask, normalizeVerdict } from '../harness/senior.ts';
import { readTaskAssignment } from './assignment.ts';
import { getBranchTipCommit } from '../worktrees/commit.ts';
import { getDeliveryGatingReview } from '../delivery/diff_review_gate.ts';
import { readSeniorStallRetries } from './work_review_cycle.ts';
import { JUNIOR_COMPLETION_INSTRUCTION } from '../harness/antigravity.ts';

/** F4: how many junior-fix rounds a diff-review AMEND may loop before it holds
 *  at the gate for the operator. Bounds the diff-review-amend → junior-fix loop. */
export const DIFF_REVIEW_FIX_CEILING = 3;

/**
 * Diff-review cycle — the CODE-DIFF (phase4) senior review that gates delivery.
 *
 * The department's OTHER senior touchpoints review artifacts a junior wrote: the
 * plan (before coding) and the walkthrough (the junior's narrative of the work).
 * N2 (`engine/delivery/diff_review_gate.ts`) makes delivery — pr.create / pr.merge
 * and the out-of-band merge guard — key on the latest APPROVED **phase4**
 * code-diff review at the branch tip, precisely so the FINAL diff is senior-read
 * before anything merges (the b55e2fda / N1a incidents: a walkthrough approval
 * used to satisfy delivery and the real diff was never reviewed).
 *
 * Before this cycle, NOTHING in the flow produced that phase4 row. The legacy
 * `senior.review-work` job could (the `engine/review/*` `callModel` path) but is
 * never enqueued and is slated for retirement (`docs/plan-single-senior-per-task.md`
 * §3), so the phase4 rows on delivered tasks were all created OUT OF BAND by a
 * peer session — the exact anti-pattern that plan forbids. This closes the gap
 * the intended way: the task's SAME assigned senior (single-senior-per-task)
 * reviews the real `git diff base..tip` through the harness, and the verdict is
 * recorded as the phase4 delivery gate.
 *
 * Trigger: the operator's Approve (`approveTask`) enqueues `work.diff-review`
 * instead of `pr.create`. On APPROVE this cycle chains to `pr.create` → `pr.merge`;
 * on AMEND it records the review, notifies the operator, and HOLDS the task in
 * needs-review (the human done-gate is never bypassed and nothing merges). The
 * cycle is idempotent: if an approved phase4 review already stands at the current
 * tip (e.g. a re-drive, or a review recorded elsewhere), it skips the senior call
 * and chains straight to delivery — the review-dedup guard the single-senior plan
 * calls for.
 */

const UNSPECIFIED_MODEL = 'unspecified';

export interface DiffReviewCycleOptions {
  taskId: string;
  /** Which senior reviews. Default: the task's pinned senior, else the policy. */
  seniorId?: string;
  seniorModel?: string;
  /** Cancellation (job timeout / runner shutdown), honored by the senior wait. */
  signal?: AbortSignal;
  /** The job invoking this cycle, for span attribution. */
  jobId?: string;
}

export type DiffReviewResult =
  | { outcome: 'already-approved'; reviewedCommit: string; deliveryJobId?: string }
  | { outcome: 'approved'; senior: string; reviewId: string; reviewedCommit: string; deliveryJobId?: string }
  | { outcome: 'amend'; senior: string; reviewId: string; reviewedCommit: string; feedback: string }
  | { outcome: 'skipped'; reason: 'not_needs_review' | 'no_worktree' }
  | { outcome: 'blocked'; reason: 'senior_stall_exhausted'; senior: string; attempts: number };

/** Enqueue pr.create for the task unless a prepare/create/merge delivery job is
 *  already in flight (idempotent, so a re-run never double-delivers). Returns the
 *  new job id, or undefined when one was already pending/running. */
function enqueueDeliveryIfAbsent(db: DbConnection, taskId: string): string | undefined {
  const inFlight = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_jobs
      WHERE task_id = ? AND kind IN ('pr.create','pr.merge') AND state IN ('pending','running')`,
    taskId
  );
  if (inFlight && inFlight.n > 0) return undefined;
  return enqueueJob(db, { kind: 'pr.create', task_id: taskId, payload: { taskId } }).id;
}

export async function runDiffReviewCycle(
  db: DbConnection,
  opts: DiffReviewCycleOptions
): Promise<DiffReviewResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', opts.taskId);
  if (!task) throw new Error(`Task '${opts.taskId}' not found in bureau_tasks`);

  const rubricAttribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: 'deterministic',
    model: 'preconditions',
    account: null
  };

  // Only review at the human gate. The diff-review is the delivery-time code
  // review; running it off-gate would review a moving target.
  if (task.state !== 'needs-review') {
    journal(db, {
      kind: 'guardrail',
      attribution: rubricAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      detail: { action: 'diff_review_off_gate', state: task.state }
    });
    return { outcome: 'skipped', reason: 'not_needs_review' };
  }

  // The commit under review is the current branch tip. Delivery (pr.create)
  // enforces reviewed_commit === tip, so the phase4 row must key on this exact
  // hash. No worktree → nothing to review.
  let tip: string;
  try {
    tip = await getBranchTipCommit(db, task.id);
  } catch (err: any) {
    journal(db, {
      kind: 'guardrail',
      attribution: rubricAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      detail: { action: 'diff_review_no_worktree', error: err?.message ?? String(err) }
    });
    notifyOperator(
      opts.jobId ?? 'work.diff-review',
      `Task ${task.id} diff review found no worktree to read a diff from — check the junior's implementation dispatch`
    );
    return { outcome: 'skipped', reason: 'no_worktree' };
  }

  // Dedup / idempotency: an approved phase4 review already standing at THIS tip
  // satisfies the delivery gate — skip the senior call and chain to delivery.
  const existing = getDeliveryGatingReview(db, task.id);
  if (existing && existing.reviewed_commit === tip) {
    const deliveryJobId = enqueueDeliveryIfAbsent(db, task.id);
    journal(db, {
      kind: 'system',
      attribution: rubricAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      detail: { action: 'diff_review_dedup_skip', reviewed_commit: tip, deliveryJobId }
    });
    return { outcome: 'already-approved', reviewedCommit: tip, deliveryJobId };
  }

  // Read the actual diff over the task's bureau worktree (base_commit..tip).
  const wtRow = db.get<{ path: string; base_commit: string }>(
    "SELECT path, base_commit FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
    task.id
  );
  if (!wtRow) {
    journal(db, {
      kind: 'guardrail',
      attribution: rubricAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      detail: { action: 'diff_review_no_worktree_row' }
    });
    return { outcome: 'skipped', reason: 'no_worktree' };
  }

  let diffText = '';
  try {
    diffText = execSync(`git diff ${wtRow.base_commit}..HEAD`, {
      cwd: wtRow.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024
    });
  } catch {
    diffText = 'git diff unavailable';
  }

  // Project context (name/path) for the senior, mirroring work_review_cycle.
  let projectInfo: { name: string; path: string } | undefined;
  if (task.project_id) {
    const proj = db.get<{ name: string; path_to_repo: string }>(
      'SELECT name, path_to_repo FROM bureau_projects WHERE id = ?',
      task.project_id
    );
    if (proj) projectInfo = { name: proj.name, path: proj.path_to_repo };
  }

  // Single-senior-per-task: the diff is reviewed by the SAME senior that owns
  // this task's plan + walkthrough. The claim-time pin wins; fall back to the
  // deterministic per-task policy.
  const pin = readTaskAssignment(db, task.id);
  const seniorId = opts.seniorId ?? pin?.senior ?? assignSeniorForTask(task.id);
  const senior = getSeniorDriver(seniorId);
  const maxRetries = readSeniorStallRetries(db);

  let review: Awaited<ReturnType<typeof senior.review>> | null = null;
  let attempts = 0;
  while (attempts <= maxRetries) {
    attempts++;
    try {
      review = await senior.review({
        kind: 'diff',
        taskTitle: task.title,
        taskIntent: task.intent ?? undefined,
        taskSpec: task.spec ?? undefined,
        taskAcceptance: task.acceptance ?? undefined,
        projectName: projectInfo?.name,
        projectPath: projectInfo?.path,
        diff: diffText,
        model: opts.seniorModel,
        // Reuse the task senior's conversation — it already reviewed the plan and
        // walkthrough for this task. A retry starts fresh to clear stuck state.
        freshConversation: attempts > 1
      });
      break;
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempts <= maxRetries) {
        journal(db, {
          kind: 'guardrail',
          attribution: rubricAttribution,
          taskId: task.id,
          workUuid: task.work_uuid,
          jobId: opts.jobId ?? null,
          detail: { action: 'senior_review_retry', stage: 'diff-review', senior: seniorId, attempt: attempts, maxRetries, error: errorMsg }
        });
      } else {
        const exhaustionAttribution: AttributionTuple = {
          actor_role: 'senior-engineer',
          provider: seniorId,
          model: opts.seniorModel ?? UNSPECIFIED_MODEL,
          account: null
        };
        journal(db, {
          kind: 'guardrail',
          attribution: exhaustionAttribution,
          taskId: task.id,
          workUuid: task.work_uuid,
          jobId: opts.jobId ?? null,
          detail: { action: 'senior_stall_exhausted', stage: 'diff-review', senior: seniorId, attempts, error: errorMsg }
        });
        // The task was already human-approved and stays at the gate (needs-review)
        // — a stalled senior is an infra failure, not a rejection, so we do NOT
        // demote the task. The operator re-arms delivery by re-driving the review.
        notifyOperator(
          opts.jobId ?? 'work.diff-review',
          `Task ${task.id} diff-review senior stalled/failed after ${attempts} attempt(s) (${seniorId}) — ` +
            `held in needs-review; re-drive the diff review to deliver`
        );
        return { outcome: 'blocked', reason: 'senior_stall_exhausted', senior: seniorId, attempts };
      }
    }
  }

  if (!review) {
    throw new Error(`Unexpected state: senior diff review missing after retry loop for task ${task.id}`);
  }

  const verdict = normalizeVerdict(review.verdict);
  const model = review.model ?? opts.seniorModel ?? UNSPECIFIED_MODEL;
  const attribution: AttributionTuple = { actor_role: 'senior-engineer', provider: seniorId, model, account: null };
  const reviewId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reviewId,
      task.id,
      task.work_uuid,
      WORK_REVIEW_DIFF_PHASE,
      task.cycles,
      verdict,
      review.feedback,
      tip,
      attribution.actor_role,
      attribution.provider,
      attribution.model,
      attribution.account,
      nowIso
    );
    journal(db, {
      kind: 'review',
      attribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      tokensIn: review.usage?.inputTokens ?? null,
      tokensOut: review.usage?.outputTokens ?? null,
      costUsd: review.usage?.costUsd ?? null,
      detail: { stage: 'diff-review', senior: seniorId, model: attribution.model, verdict, reviewId, reviewed_commit: tip, feedback: review.feedback }
    });
  });

  if (verdict === 'approved') {
    const deliveryJobId = enqueueDeliveryIfAbsent(db, task.id);
    notifyOperator(
      opts.jobId ?? 'work.diff-review',
      `Task ${task.id} code-diff APPROVED by ${seniorId} at ${tip.slice(0, 10)} — delivering (pr.create → pr.merge)`
    );
    return { outcome: 'approved', senior: seniorId, reviewId, reviewedCommit: tip, deliveryJobId };
  }

  // AMEND: the delivery-gate senior wants changes. F4 — loop the fixes back to
  // the junior (bounded), instead of only holding. The task STAYS at needs-review
  // (needs-review → claimed is illegal), the junior fixes in the worktree, and the
  // dispatch chains back to work.diff-review at the new tip (chainDiffReview). On
  // approve it delivers; on amend it loops, up to DIFF_REVIEW_FIX_CEILING rounds.
  const priorAmends =
    db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM bureau_work_reviews WHERE task_id = ? AND phase = ? AND verdict = 'amend'`,
      task.id,
      WORK_REVIEW_DIFF_PHASE
    )?.n ?? 0;
  const assignment = readTaskAssignment(db, task.id);
  // priorAmends counts ALL phase4 amend rows INCLUDING the one just recorded this
  // round, so `<=` yields a true DIFF_REVIEW_FIX_CEILING fix dispatches (rounds
  // 1..CEILING), then holds — the count and the "exhausted" message agree.
  if (priorAmends <= DIFF_REVIEW_FIX_CEILING && assignment?.junior) {
    const round = priorAmends; // 1-based: this row is already recorded
    const fixPrompt =
      (task.id ? `[bureau-task:${task.id}] ${task.title}\n\n` : '') +
      'CONTEXT — READ FIRST: this may arrive in a NEW conversation. The task and ' +
      'EVERY required change are below; touch only what they need, do not re-derive ' +
      'prior work.\n\n' +
      `A senior reviewed your CODE DIFF at the delivery gate and is requesting changes ` +
      `(revision round ${round} of at most ${DIFF_REVIEW_FIX_CEILING}). Implement EVERY ` +
      'required change below in the worktree, then finish with an updated summary of ' +
      'what you changed and the tests you ran — the senior will re-review the diff.\n\n' +
      '===== TASK =====\n' +
      `TITLE: ${task.title}\n` +
      (projectInfo ? `PROJECT: ${projectInfo.name} (${projectInfo.path})\n` : '') +
      (task.intent ? `INTENT: ${task.intent}\n` : '') +
      (task.spec ? `SPEC: ${task.spec}\n` : '') +
      (task.acceptance ? `ACCEPTANCE: ${task.acceptance}\n` : '') +
      `\n===== SENIOR'S REQUIRED CHANGES =====\n${review.feedback.trim()}\n\n${JUNIOR_COMPLETION_INSTRUCTION}`;
    const dispatchId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const fixJob = db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
         VALUES (?, ?, ?, 'junior-engineer', 'antigravity', NULL, NULL, 'pending', ?)`,
        dispatchId,
        task.id,
        task.work_uuid,
        nowIso
      );
      return enqueueJob(db, {
        kind: 'junior.dispatch',
        task_id: task.id,
        payload: { dispatchId, stage: 'diff-review-fix', prompt: fixPrompt, junior: assignment.junior, freshConversation: false, chainDiffReview: true },
        max_attempts: 1
      });
    });
    journal(db, {
      kind: 'system',
      attribution,
      taskId: task.id,
      jobId: opts.jobId ?? null,
      detail: { action: 'diff_review_fix_dispatch', round, ceiling: DIFF_REVIEW_FIX_CEILING, junior: assignment.junior, dispatchJobId: fixJob.id }
    });
    notifyOperator(
      opts.jobId ?? 'work.diff-review',
      `Task ${task.id} code-diff needs changes (${seniorId}, round ${round}/${DIFF_REVIEW_FIX_CEILING}) — dispatched junior ${assignment.junior} to fix; re-reviews the diff at the new tip. Stays needs-review.`
    );
    return { outcome: 'amend', senior: seniorId, reviewId, reviewedCommit: tip, feedback: review.feedback };
  }

  // Ceiling reached (or no junior assigned): hold at the human gate for the
  // operator — the loop never runs forever, and delivery is never bypassed.
  notifyOperator(
    opts.jobId ?? 'work.diff-review',
    `Task ${task.id} code-diff review requires changes (${seniorId}) — ${assignment?.junior ? `${DIFF_REVIEW_FIX_CEILING} fix rounds exhausted` : 'no junior assigned'}; held in needs-review, NOT delivered. ` +
      `Required changes: ${review.feedback}`
  );
  return { outcome: 'amend', senior: seniorId, reviewId, reviewedCommit: tip, feedback: review.feedback };
}
