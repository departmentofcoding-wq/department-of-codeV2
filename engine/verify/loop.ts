import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/index.ts';
import { VERIFIER_ATTRIBUTION } from '../contract/constants.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { transition } from '../state/machine.ts';
import { notifyOperator } from '../state/notifications.ts';
import type { VerifyRunResult } from './verifier.ts';

export interface VerifyOutcomeResult {
  isSuccess: boolean;
  isSendback: boolean;
}

export interface VerifyOutcomeOptions {
  /**
   * The current worktree tip commit, read by the caller BEFORE the finalization
   * transaction (a git subprocess must not run inside `execTransaction`). Used
   * only on the success path to detect a stale standing approval (N1/defect 2).
   * Undefined when the caller could not read it (e.g. the fake workspace
   * provider in unit tests) — the stale-approval guard is then skipped, so
   * behaviour is identical to before this fix.
   */
  tip?: string;
}

/**
 * Executes all synchronous database state transitions and job enqueues for a verifier run outcome.
 * MUST be invoked inside the finalization transaction in executeVerifyRunJob.
 */
export function handleVerifyOutcome(
  db: DbConnection,
  taskId: string,
  outcome: VerifyRunResult,
  attribution: AttributionTuple = VERIFIER_ATTRIBUTION,
  opts: VerifyOutcomeOptions = {}
): VerifyOutcomeResult {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for verification outcome handling`);
  }

  // Ceiling read with fallback 2
  const ceilingRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    'verify:fixes:ceiling'
  );
  const rawCeiling = ceilingRow ? parseInt(ceilingRow.value, 10) : 2;
  const ceiling = Number.isFinite(rawCeiling) ? rawCeiling : 2;

  const isSuccess = outcome.exitCode === 0 && !outcome.timedOut;

  if (isSuccess) {
    db.run('UPDATE bureau_tasks SET verifier_exit_code = 0 WHERE id = ?', taskId);

    // N1 / defect 2: never reach the delivery gate on a STALE approval. A
    // `verify-failure-sendback` checkpoint commits whatever is dirty in the
    // worktree (e.g. an out-of-band junior still editing — N0), which can move
    // the branch tip PAST the commit the senior approved. If that happens, a
    // later passing verify would land at `needs-review` while the standing
    // approval still points at the old commit — `pr.create` then refuses on
    // `reviewed_commit != tip` and the task STRANDS looking delivery-ready (the
    // b55e2fda scar, which needed a manual re-review). Instead, re-enter senior
    // work review at the new tip so the flow self-heals. Skipped when `tip` is
    // unreadable (fake provider) — identical to pre-fix behaviour.
    if (opts.tip) {
      const approval = db.get<{ reviewed_commit: string }>(
        `SELECT reviewed_commit FROM bureau_work_reviews
         WHERE task_id = ? AND verdict = 'approved' AND reviewed_commit IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        taskId
      );
      if (approval && approval.reviewed_commit !== opts.tip) {
        // Back into the work loop (verifying -> claimed is already legal — the
        // sendback path uses it) and re-review at the moved tip.
        transition(db, taskId, 'claimed', attribution, {
          action: 'verify_passed_stale_approval',
          reviewed_commit: approval.reviewed_commit,
          tip: opts.tip
        });
        // Self-heal via the live review path. Idempotent: skip if a review or
        // verify job for this task is already in flight (mirrors the
        // work-review cycle's own re-entry guard).
        const inFlight = db.get<{ n: number }>(
          `SELECT COUNT(*) n FROM bureau_jobs
           WHERE task_id = ? AND kind IN ('work.cycle','worktree.prepare','verify.run')
           AND state IN ('pending','running')`,
          taskId
        );
        if (!inFlight || inFlight.n === 0) {
          enqueueJob(db, { kind: 'work.cycle', task_id: taskId, payload: { taskId } });
        }
        journal(db, {
          kind: 'guardrail',
          attribution,
          taskId,
          detail: {
            reason: 'verify_passed_stale_approval',
            reviewed_commit: approval.reviewed_commit,
            tip: opts.tip
          }
        });
        notifyOperator(
          taskId,
          `verify passed but the standing approval is stale ` +
            `(reviewed ${approval.reviewed_commit.slice(0, 8)} != tip ${opts.tip.slice(0, 8)}) ` +
            `— re-reviewing at the new tip before delivery`
        );
        return { isSuccess: false, isSendback: false };
      }
    }

    transition(db, taskId, 'needs-review', attribution, {
      action: 'verify_passed',
      duration_ms: outcome.durationMs
    });
    return { isSuccess: true, isSendback: false };
  }

  // Failure path: check verify_fixes budget ceiling
  if (task.verify_fixes < ceiling) {
    // Send-back loop: atomic increment, transition to claimed, and re-enqueue verify.run
    const newFixes = task.verify_fixes + 1;
    db.run('UPDATE bureau_tasks SET verify_fixes = ? WHERE id = ?', newFixes, taskId);
    transition(db, taskId, 'claimed', attribution, {
      action: 'verify_failed_sendback',
      verify_fixes: newFixes,
      ceiling,
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut
    });
    enqueueJob(db, {
      kind: 'verify.run',
      task_id: taskId,
      payload: { taskId }
    });
    return { isSuccess: false, isSendback: true };
  } else {
    // Budget ceiling reached: block task and notify operator
    transition(db, taskId, 'blocked', attribution, {
      action: 'verify_ceiling_reached',
      verify_fixes: task.verify_fixes,
      ceiling,
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut
    });

    journal(db, {
      kind: 'guardrail',
      attribution,
      taskId,
      detail: {
        reason: 'verify_fixes ceiling reached',
        verify_fixes: task.verify_fixes,
        ceiling
      }
    });

    notifyOperator(taskId, 'verify_fixes ceiling reached');
    return { isSuccess: false, isSendback: false };
  }
}
