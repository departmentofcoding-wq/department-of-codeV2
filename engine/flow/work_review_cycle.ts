import crypto from 'node:crypto';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { notifyOperator } from '../state/notifications.ts';
import { getSeniorDriver } from '../harness/senior-seam.ts';
import { assignSenior } from '../harness/senior.ts';
import { readLatestArtifacts } from '../harness/junior-artifacts.ts';

/**
 * Work-review cycle — the department flow for the stage AFTER implementation,
 * the sibling of `plan_review_cycle`. The plan cycle ends by dispatching the
 * junior to implement; nothing then made a senior READ THE WALKTHROUGH, so a
 * task that had code written stalled with no review of the work (the gap the
 * first real run exposed). This closes it:
 *
 *   IMPLEMENTATION DONE → senior REVIEWS the walkthrough (with the task verbatim)
 *   → approved | revise, recorded as a real `bureau_work_reviews` row + `review`
 *   journal span, and surfaced to the operator.
 *
 * It reviews the captured **walkthrough artifact** (not a bureau worktree) — the
 * same harness-artifact model the plan cycle uses — because the Antigravity
 * junior writes in its own IDE workspace, not a bureau-managed worktree. The
 * done-gate is deliberately untouched: reaching `done` still requires verifier
 * exit 0 + human approval (`engine/state/machine.ts`). This cycle makes the
 * senior read the work and hands the operator a verdict; it never marks a task
 * done, and never bypasses the DB invariant.
 */

/** Attribution recorded when no real model label is known — honest, never a
 *  fabricated model name. */
const UNSPECIFIED_MODEL = 'unspecified';

export interface WorkReviewCycleOptions {
  taskId: string;
  /** Which senior reviews. Default: the assignment policy for walkthroughs. */
  seniorId?: string;
  seniorModel?: string;
  /** Walkthrough text override. When omitted, the latest captured artifact for
   *  the task is read from `docs/junior-artifacts/<taskId>/`. */
  walkthrough?: string;
  /** Cancellation (job timeout / runner shutdown), honored by the senior wait. */
  signal?: AbortSignal;
  /** The job invoking this cycle, for span attribution. */
  jobId?: string;
}

export type WorkReviewResult =
  | { outcome: 'approved' | 'revise'; senior: string; feedback: string; reviewId: string }
  | { outcome: 'skipped'; reason: 'no_walkthrough' };

export async function runWorkReviewCycle(
  db: DbConnection,
  opts: WorkReviewCycleOptions
): Promise<WorkReviewResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', opts.taskId);
  if (!task) throw new Error(`Task '${opts.taskId}' not found in bureau_tasks`);

  // Resolve the walkthrough the senior will read — caller override first, else
  // the newest captured artifact (walkthrough > reply > transcript).
  let walkthrough = (opts.walkthrough ?? '').trim();
  if (!walkthrough) {
    const art = readLatestArtifacts(task.id);
    walkthrough = (art.walkthrough || art.reply || art.transcript || '').trim();
  }

  const rubricAttribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: 'deterministic',
    model: 'preconditions',
    account: null
  };

  if (!walkthrough) {
    // Nothing to review. Surface to the operator rather than billing a senior for
    // an empty artifact or silently treating the work as reviewed.
    journal(db, {
      kind: 'guardrail',
      attribution: rubricAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      detail: { action: 'work_review_no_walkthrough' }
    });
    notifyOperator(
      opts.jobId ?? 'work.cycle',
      `Task ${task.id} has no captured walkthrough to review — check the junior's implementation dispatch`
    );
    return { outcome: 'skipped', reason: 'no_walkthrough' };
  }

  const seniorId = opts.seniorId ?? assignSenior({ kind: 'walkthrough' });
  const senior = getSeniorDriver(seniorId);
  const review = await senior.review({
    kind: 'walkthrough',
    taskTitle: task.title,
    taskIntent: task.intent ?? undefined,
    taskSpec: task.spec ?? undefined,
    taskAcceptance: task.acceptance ?? undefined,
    walkthrough,
    model: opts.seniorModel
  });

  const verdict = review.verdict === 'approve' ? 'approved' : 'amend';
  const model = review.model ?? opts.seniorModel ?? UNSPECIFIED_MODEL;
  const attribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: seniorId,
    model,
    account: null
  };
  const reviewId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, 'walkthrough', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      reviewId,
      task.id,
      task.work_uuid,
      task.cycles ?? 0,
      verdict,
      review.feedback,
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
      detail: { stage: 'work-review', senior: seniorId, verdict, reviewId }
    });
  });

  if (verdict === 'approved') {
    notifyOperator(
      opts.jobId ?? 'work.cycle',
      `Task ${task.id} walkthrough APPROVED by ${seniorId} — ready for verify + operator approval ` +
        `(the done-gate: verifier exit 0 + human approval)`
    );
    return { outcome: 'approved', senior: seniorId, feedback: review.feedback, reviewId };
  }

  notifyOperator(
    opts.jobId ?? 'work.cycle',
    `Task ${task.id} walkthrough needs changes (${seniorId}) — operator decision required`
  );
  return { outcome: 'revise', senior: seniorId, feedback: review.feedback, reviewId };
}
