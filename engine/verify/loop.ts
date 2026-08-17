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

/**
 * Executes all synchronous database state transitions and job enqueues for a verifier run outcome.
 * MUST be invoked inside the finalization transaction in executeVerifyRunJob.
 */
export function handleVerifyOutcome(
  db: DbConnection,
  taskId: string,
  outcome: VerifyRunResult,
  attribution: AttributionTuple = VERIFIER_ATTRIBUTION
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
