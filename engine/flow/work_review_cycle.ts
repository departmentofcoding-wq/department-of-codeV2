import crypto from 'node:crypto';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { DEFAULT_WORK_ROUNDS_CEILING, DEFAULT_SENIOR_STALL_RETRIES, REVIEW_PR_META_KEYS } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { transition } from '../state/machine.ts';
import { notifyOperator } from '../state/notifications.ts';
import { getSeniorDriver } from '../harness/senior-seam.ts';
import { assignSeniorForTask } from '../harness/senior.ts';
import { readLatestArtifacts } from '../harness/junior-artifacts.ts';
import { assignJunior, JUNIOR_COMPLETION_INSTRUCTION } from '../harness/antigravity.ts';
import { readTaskAssignment, ensureTaskAssignment } from './assignment.ts';
import { getWorkspaceProviderOverride } from '../contract/workspace-seam.ts';
import { getBranchTipCommit } from '../worktrees/commit.ts';

/**
 * Work-review cycle — the department flow for the stage AFTER implementation,
 * the sibling of `plan_review_cycle`. It CYCLES like the plan review does:
 *
 *   WALKTHROUGH → senior REVIEWS it (with the task verbatim)
 *     ├─ approve → the work is accepted; ready for verify + operator approval
 *     └─ revise  → the senior's required fixes are fed straight back to the
 *                  junior (a fresh junior.dispatch that CONTINUES its conversation),
 *                  the junior implements them, and its new walkthrough is
 *                  re-reviewed — looping until APPROVE, bounded by the
 *                  work-rounds ceiling (default 5). At the ceiling the task is
 *                  blocked and the operator notified — never looped forever.
 *
 * It reviews the captured **walkthrough artifact** (not a bureau worktree) — the
 * same harness-artifact model the plan cycle uses — because the Antigravity
 * junior writes in its own IDE workspace, not a bureau-managed worktree.
 *
 * The done-gate is deliberately untouched: reaching `done` still requires
 * verifier exit 0 + human approval (`engine/state/machine.ts`). This cycle drives
 * the review→fix loop and hands the operator an approved (or blocked) task; it
 * never marks a task done, and never bypasses the DB invariant.
 */

/** Attribution recorded when no real model label is known — honest, never a
 *  fabricated model name. */
const UNSPECIFIED_MODEL = 'unspecified';
const ANTIGRAVITY_PROVIDER = 'antigravity';

export interface WorkReviewCycleOptions {
  taskId: string;
  /** Which senior reviews. Default: the assignment policy for walkthroughs. */
  seniorId?: string;
  seniorModel?: string;
  /** Which junior implements the fixes on a REVISE. Default A. */
  junior?: string;
  juniorModel?: string;
  folder?: string;
  /** Walkthrough text override. When omitted, the latest captured artifact for
   *  the task is read from `docs/junior-artifacts/<taskId>/`. */
  walkthrough?: string;
  /** Cancellation (job timeout / runner shutdown), honored by the senior wait. */
  signal?: AbortSignal;
  /** The job invoking this cycle, for span attribution. */
  jobId?: string;
}

export type WorkReviewResult =
  | {
      outcome: 'approved';
      senior: string;
      feedback: string;
      reviewId: string;
      roundsUsed: number;
      ceiling: number;
      /** The `worktree.prepare` job enqueued to carry the task into the done-gate
       *  (verify → needs-review → operator approval → PR). Undefined only when a
       *  prepare/verify job for this task was already in flight. */
      deliveryJobId?: string;
    }
  | {
      outcome: 'revise';
      senior: string;
      feedback: string;
      reviewId: string;
      roundsUsed: number;
      ceiling: number;
      /** A fix dispatch was enqueued (the loop continues). False at the ceiling. */
      fixDispatchJobId?: string;
      /** True when the ceiling was hit and the task was blocked instead of looping. */
      ceilingReached: boolean;
    }
  | { outcome: 'skipped'; reason: 'no_walkthrough' }
  | { outcome: 'blocked'; reason: 'senior_stall_exhausted'; senior: string; attempts: number };

export function readSeniorStallRetries(db: DbConnection): number {
  const envVal = process.env['SENIOR_STALL_RETRIES'];
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.SENIOR_STALL_RETRIES
  );
  const n = row ? parseInt(row.value, 10) : DEFAULT_SENIOR_STALL_RETRIES;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SENIOR_STALL_RETRIES;
}

function readWorkCeiling(db: DbConnection): number {
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.REVIEW_WORK_ROUNDS_CEILING
  );
  const n = row ? parseInt(row.value, 10) : DEFAULT_WORK_ROUNDS_CEILING;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORK_ROUNDS_CEILING;
}

/**
 * The fix prompt handed to the junior on a REVISE: the task verbatim plus the
 * senior's required changes, told honestly (the walkthrough was reviewed and
 * needs changes — not a fresh task). The junior CONTINUES its conversation, so it
 * already holds the code it wrote.
 */
export function buildFixPrompt(
  task: BureauTaskRow,
  feedback: string,
  round: number,
  ceiling: number,
  projectInfo?: { name: string; path: string }
): string {
  return (
    `A senior reviewed your walkthrough and is requesting changes (revision round ` +
    `${round} of at most ${ceiling}). Implement EVERY required change below, then ` +
    'finish with an updated walkthrough summarizing what you changed, the test ' +
    'results, and the verification you ran — the senior will re-review it.\n\n' +
    '===== TASK =====\n' +
    `TITLE: ${task.title}\n` +
    (projectInfo ? `PROJECT: ${projectInfo.name} (${projectInfo.path})\n` : '') +
    (task.intent ? `INTENT: ${task.intent}\n` : '') +
    (task.spec ? `SPEC: ${task.spec}\n` : '') +
    (task.acceptance ? `ACCEPTANCE: ${task.acceptance}\n` : '') +
    `\n===== SENIOR'S REQUIRED CHANGES =====\n${feedback.trim()}\n\n${JUNIOR_COMPLETION_INSTRUCTION}`
  );
}

/** Insert a bureau_dispatches row + enqueue junior.dispatch for a fix round. The
 *  dispatch chains back into a work.cycle so the fixed walkthrough is re-reviewed. */
function enqueueFixDispatch(
  db: DbConnection,
  task: BureauTaskRow,
  opts: {
    prompt: string;
    junior: string;
    juniorModel: string;
    folder?: string;
    seniorId?: string;
    seniorModel?: string;
  }
) {
  const nowIso = new Date().toISOString();
  const dispatchId = crypto.randomUUID();
  db.run(
    `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
     VALUES (?, ?, ?, 'junior-engineer', ?, ?, NULL, 'pending', ?)`,
    dispatchId,
    task.id,
    task.work_uuid,
    ANTIGRAVITY_PROVIDER,
    opts.juniorModel,
    nowIso
  );
  return enqueueJob(db, {
    kind: 'junior.dispatch',
    task_id: task.id,
    payload: {
      dispatchId,
      prompt: opts.prompt,
      junior: opts.junior,
      freshConversation: false,
      // Re-review the fixed walkthrough, carrying the loop context forward.
      chainWorkReview: true,
      ...(opts.juniorModel !== UNSPECIFIED_MODEL ? { model: opts.juniorModel } : {}),
      ...(opts.folder ? { folder: opts.folder } : {}),
      ...(opts.seniorId ? { workSeniorId: opts.seniorId } : {}),
      ...(opts.seniorModel ? { workSeniorModel: opts.seniorModel } : {})
    },
    max_attempts: 1
  });
}

export async function runWorkReviewCycle(
  db: DbConnection,
  opts: WorkReviewCycleOptions
): Promise<WorkReviewResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', opts.taskId);
  if (!task) throw new Error(`Task '${opts.taskId}' not found in bureau_tasks`);

  const ceiling = readWorkCeiling(db);

  let folder = opts.folder;
  let projectInfo: { name: string; path: string } | undefined;
  if (task.project_id) {
    const proj = db.get<{ name: string; path_to_repo: string }>('SELECT name, path_to_repo FROM bureau_projects WHERE id = ?', task.project_id);
    if (proj) {
      projectInfo = { name: proj.name, path: proj.path_to_repo };
      if (!folder) {
        folder = proj.path_to_repo;
      }
    }
  }

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

  // ---- N17: the claim-time pin governs who reviews and who fixes ----------
  // The pin was written when the queue manager admitted the task (its plan
  // cycle); every phase reads it. A payload pin that DISAGREES with the row is
  // a routing bug (the cross-contamination class) — journaled, assignment wins.
  // A legacy claimed task with no pin (pre-N17) gets one now, busy-picking if
  // needed: it is already mid-flight, stranding it helps nobody.
  let pinnedJunior = opts.junior;
  let pinnedSenior = opts.seniorId;
  const pin = readTaskAssignment(db, task.id);
  if (pin) {
    if (opts.junior && opts.junior.toUpperCase() !== pin.junior) {
      journal(db, {
        kind: 'guardrail',
        attribution: rubricAttribution,
        taskId: task.id,
        workUuid: task.work_uuid,
        jobId: opts.jobId ?? null,
        detail: {
          action: 'assignment_pin_mismatch',
          door: 'work.cycle',
          payloadJunior: opts.junior,
          assignedJunior: pin.junior,
          resolution: 'assignment wins'
        }
      });
    }
    pinnedJunior = pin.junior;
    pinnedSenior = pin.senior;
  } else {
    const ensured = ensureTaskAssignment(db, task.id, {
      preferJunior: opts.junior,
      preferSenior: opts.seniorId,
      allowBusyPick: true,
      jobId: opts.jobId
    });
    if (ensured.status === 'assigned') {
      pinnedJunior = ensured.assignment.junior;
      pinnedSenior = ensured.assignment.senior;
    }
  }

  const seniorId = pinnedSenior ?? assignSeniorForTask(task.id);
  const senior = getSeniorDriver(seniorId);
  const maxRetries = readSeniorStallRetries(db);
  let review: Awaited<ReturnType<typeof senior.review>> | null = null;
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts++;
    try {
      review = await senior.review({
        kind: 'walkthrough',
        taskTitle: task.title,
        taskIntent: task.intent ?? undefined,
        taskSpec: task.spec ?? undefined,
        taskAcceptance: task.acceptance ?? undefined,
        projectName: projectInfo?.name,
        projectPath: projectInfo?.path,
        walkthrough,
        model: opts.seniorModel,
        // First work review attempt starts fresh if cycles == 0; retries (attempt > 1)
        // start fresh to clear any stuck conversation state; otherwise reuse context.
        freshConversation: attempts > 1 ? true : (task.cycles ?? 0) === 0
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
          detail: {
            action: 'senior_review_retry',
            stage: 'work-review',
            senior: seniorId,
            attempt: attempts,
            maxRetries,
            error: errorMsg
          }
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
          detail: {
            action: 'senior_stall_exhausted',
            stage: 'work-review',
            senior: seniorId,
            attempts,
            error: errorMsg
          }
        });
        const refreshed = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', task.id);
        if (refreshed && refreshed.state === 'claimed') {
          transition(db, task.id, 'blocked', exhaustionAttribution, {
            reason: 'senior_stall_exhausted',
            attempts
          });
        }
        notifyOperator(
          opts.jobId ?? 'work.cycle',
          `Task ${task.id} walkthrough senior review stalled/failed after ${attempts} attempt(s) (${seniorId}) — ` +
            `blocked for operator re-arm`
        );
        return {
          outcome: 'blocked',
          reason: 'senior_stall_exhausted',
          senior: seniorId,
          attempts
        };
      }
    }
  }

  if (!review) {
    throw new Error(`Unexpected state: senior review missing after retry loop for task ${task.id}`);
  }

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
  // This review consumes a round: cycles counts completed work-review rounds.
  const roundsUsed = (task.cycles ?? 0) + 1;

  db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, 'walkthrough', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      reviewId,
      task.id,
      task.work_uuid,
      roundsUsed,
      verdict,
      review.feedback,
      attribution.actor_role,
      attribution.provider,
      attribution.model,
      attribution.account,
      nowIso
    );
    db.run(`UPDATE bureau_tasks SET cycles = ?, updated_at = ? WHERE id = ?`, roundsUsed, nowIso, task.id);
    journal(db, {
      kind: 'review',
      attribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: opts.jobId ?? null,
      detail: {
        stage: 'work-review',
        senior: seniorId,
        verdict,
        reviewId,
        round: roundsUsed,
        ceiling,
        // N17: the senior's full reply is on the journal record.
        feedback: review.feedback
      }
    });
  });

  if (verdict === 'approved') {
    // Capture the reviewed commit for delivery. The junior implemented IN the
    // task's bureau worktree (see dispatch-job's "junior_pointed_at_worktree"), so
    // commit any pending edits (checkpoint) and record the worktree tip as this
    // review's `reviewed_commit`. That satisfies pr.create's guard
    // (`reviewed_commit === branch tip`) so the junior's ACTUAL work is what gets
    // pushed and merged — not an empty diff.
    const wtRow = db.get<{ path: string; status: string }>(
      "SELECT path, status FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
      task.id
    );

    if (wtRow) {
      const wsProvider = getWorkspaceProviderOverride();
      if (wsProvider) {
        try {
          await wsProvider.checkpoint(db, task.id, attribution, 'walkthrough-approved');
        } catch {
          // Checkpoint failure is best-effort before recording tip
        }
      }
      try {
        const tip = await getBranchTipCommit(db, task.id);
        db.run('UPDATE bureau_work_reviews SET reviewed_commit = ? WHERE id = ?', tip, reviewId);
        journal(db, {
          kind: 'system',
          attribution,
          taskId: task.id,
          workUuid: task.work_uuid,
          jobId: opts.jobId ?? null,
          detail: { action: 'reviewed_commit_recorded', reviewed_commit: tip, reviewId }
        });
      } catch (err: any) {
        journal(db, {
          kind: 'guardrail',
          attribution,
          taskId: task.id,
          workUuid: task.work_uuid,
          jobId: opts.jobId ?? null,
          detail: { reason: 'reviewed_commit_failed', error: err?.message ?? String(err), reviewId }
        });
        throw new Error(`Failed to record reviewed_commit for task ${task.id}: ${err?.message ?? String(err)}`);
      }
    } else {
      journal(db, {
        kind: 'guardrail',
        attribution,
        taskId: task.id,
        workUuid: task.work_uuid,
        jobId: opts.jobId ?? null,
        detail: { reason: 'no_worktree_row_for_task', reviewId, taskId: task.id }
      });
    }
    // Advance the task into the department done-gate instead of dead-ending in
    // `claimed`. Enqueue `worktree.prepare`, which registers the bureau worktree
    // and chains `verify.run` → (verifier exit 0) → `needs-review`, where the
    // operator's Approve triggers `pr.create` → `pr.merge`. Reuses the existing,
    // tested chain (the "register worktree, reuse chain" wiring); human approval
    // stays the gate, so nothing merges to main without a person. Idempotent: skip
    // if a prepare/verify job for this task is already in flight.
    const inFlight = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM bureau_jobs
       WHERE task_id = ? AND kind IN ('worktree.prepare','verify.run') AND state IN ('pending','running')`,
      task.id
    );
    let deliveryJobId: string | undefined;
    if (!inFlight || inFlight.n === 0) {
      deliveryJobId = enqueueJob(db, {
        kind: 'worktree.prepare',
        task_id: task.id,
        payload: { taskId: task.id }
      }).id;
    }
    notifyOperator(
      opts.jobId ?? 'work.cycle',
      `Task ${task.id} walkthrough APPROVED by ${seniorId} after ${roundsUsed} round(s) — verifying now, ` +
        `then it lands in needs-review for operator approval (the done-gate: verifier exit 0 + human approval)`
    );
    return { outcome: 'approved', senior: seniorId, feedback: review.feedback, reviewId, roundsUsed, ceiling, deliveryJobId };
  }

  // REVISE. Loop the fixes back to the junior, unless the ceiling is reached.
  if (roundsUsed >= ceiling) {
    // The senior still isn't satisfied after the maximum rounds. Block the task
    // and hand it to the operator rather than looping the live agents forever.
    const refreshed = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', task.id);
    if (refreshed && refreshed.state === 'claimed') {
      transition(db, task.id, 'blocked', attribution, {
        reason: 'work_rounds_ceiling_exceeded_after_amend',
        rounds: roundsUsed,
        ceiling
      });
    }
    notifyOperator(
      opts.jobId ?? 'work.cycle',
      `Task ${task.id} still not approved after ${roundsUsed} work-review round(s) (ceiling ${ceiling}) — ` +
        `blocked for the operator. Latest required changes: ${review.feedback}`
    );
    return {
      outcome: 'revise',
      senior: seniorId,
      feedback: review.feedback,
      reviewId,
      roundsUsed,
      ceiling,
      ceilingReached: true
    };
  }

  const fixPrompt = buildFixPrompt(task, review.feedback, roundsUsed + 1, ceiling, projectInfo);
  const fixJob = enqueueFixDispatch(db, task, {
    prompt: fixPrompt,
    // N17: the claim-time pin — the SAME junior that authored and implemented
    // gets the fixes, in its same conversation. Deterministic policy only as a
    // legacy fallback for pre-N17 tasks that somehow have no pin.
    junior: (pinnedJunior || assignJunior({ taskId: task.id })).toUpperCase(),
    juniorModel: opts.juniorModel ?? UNSPECIFIED_MODEL,
    folder: folder,
    seniorId: pinnedSenior,
    seniorModel: opts.seniorModel
  });
  notifyOperator(
    opts.jobId ?? 'work.cycle',
    `Task ${task.id} walkthrough needs changes (round ${roundsUsed}/${ceiling}, ${seniorId}) — ` +
      `the junior is implementing the fixes for re-review`
  );
  return {
    outcome: 'revise',
    senior: seniorId,
    feedback: review.feedback,
    reviewId,
    roundsUsed,
    ceiling,
    fixDispatchJobId: fixJob.id,
    ceilingReached: false
  };
}
