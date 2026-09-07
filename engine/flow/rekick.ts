import type { AttributionTuple, BureauJobRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { enqueueJobIfAbsent } from '../jobs/jobs.ts';
import { planCycleJobId } from '../jobs/ids.ts';
import { notifyOperator } from '../state/notifications.ts';

/**
 * The operator's recovery door for a stranded flow.
 *
 * When a `plan.cycle`, `junior.dispatch`, `work.cycle`, or `work.diff-review` job dies
 * (harness cold-start races, a downed junior, a reaped-then-dead lease), the task row
 * is left `queued`, `claimed`, or `blocked` with no machinery that will ever move it again:
 * the reconciler deliberately does not retry failed cycles, and dispatches/reviews have
 * no auto-retry once dead. This helper productizes that recovery runbook as a journaled,
 * attributed, idempotent act through the engine's tracked path.
 *
 * Single-Row Deterministic Identity & Recovery Rules:
 * - `queued` task → deterministic `plan.cycle:<taskId>` job.
 *   - Absent row: enqueued via INSERT OR IGNORE.
 *   - Present dead row: revived in-place via atomic UPDATE ... WHERE state = 'dead'.
 * - `claimed` task → latest phase job (`junior.dispatch`, `work.cycle`, `work.diff-review`).
 *   - Present dead row: revived in-place via atomic UPDATE ... WHERE state = 'dead' reusing
 *     the exact stored payload, preserving task's assigned junior and senior pins.
 *   - Absent row: enqueued via INSERT OR IGNORE under deterministic ID scheme.
 * - `blocked` task → revives the exact dead cycle job for the task's phase without mutating
 *   fix budgets (done-gate & merge law untouched).
 * - Idempotency / Double-Click Harmlessness:
 *   - If the target job is already alive (`pending` or `running`), returns `already-running`
 *     with `{ ok: true, jobId, alreadyRunning: true }` without errors or extra rows.
 * - Fail-closed: `done` tasks, archived tasks (`archived_at IS NOT NULL`), or tasks in non-resumable
 *   states are rejected with `{ ok: false, reason }`.
 */

export type RekickResult =
  | { ok: true; action: 'plan-cycle-reset' | 'plan-cycle-enqueued' | 'dispatch-reset' | 'cycle-reset' | 'already-running'; jobId: string; alreadyRunning?: boolean }
  | { ok: false; reason: string };

export function rekickTaskFlow(db: DbConnection, taskId: string, attribution: AttributionTuple): RekickResult {
  const task = db.get<{ id: string; state: string; archived_at: string | null }>(
    'SELECT id, state, archived_at FROM bureau_tasks WHERE id = ?',
    taskId
  );
  if (!task) return { ok: false, reason: `Task ${taskId} not found` };

  if (task.archived_at !== null) {
    return { ok: false, reason: `Task ${taskId} is archived — archived tasks cannot be resumed` };
  }

  if (task.state === 'done') {
    return { ok: false, reason: `Task ${taskId} is already done — done tasks cannot be resumed` };
  }

  if (task.state === 'queued') {
    const jobId = planCycleJobId(taskId);
    const existing = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);

    if (!existing) {
      // Absent row: enqueue via INSERT OR IGNORE under the deterministic plan.cycle ID.
      const res = enqueueJobIfAbsent(db, {
        id: jobId,
        kind: 'plan.cycle',
        task_id: taskId,
        payload: { taskId },
        max_attempts: 1
      });
      journal(db, {
        kind: 'human',
        attribution,
        taskId,
        jobId,
        detail: { action: 'resume', target: 'plan.cycle', outcome: 'enqueued' }
      });
      notifyOperator('task.resumed', `Task ${taskId} resumed: plan.cycle enqueued (${jobId})`);
      return { ok: true, action: 'plan-cycle-enqueued', jobId };
    }

    if (existing.state === 'pending' || existing.state === 'running') {
      // Harmless double-click idempotency: job already alive
      return { ok: true, action: 'already-running', jobId, alreadyRunning: true };
    }

    if (existing.state !== 'dead') {
      return { ok: false, reason: `plan.cycle job ${jobId} is in state '${existing.state}', not dead — cannot resume` };
    }

    // Atomic in-place revival of the dead job row
    const reset = db.execTransaction(() => {
      const res = db.run(
        `UPDATE bureau_jobs
         SET state = 'pending',
             attempts = 0,
             reaped_count = 0,
             last_error = NULL,
             run_after = NULL,
             lease_owner = NULL,
             lease_expires_at = NULL,
             started_at = NULL,
             finished_at = NULL
         WHERE id = ? AND state = 'dead'`,
        jobId
      );
      if (res.changes === 0) return false;
      journal(db, {
        kind: 'human',
        attribution,
        taskId,
        jobId,
        detail: {
          action: 'resume',
          target: 'plan.cycle',
          outcome: 'reset',
          prior_attempts: existing.attempts,
          prior_error: existing.last_error
        }
      });
      return true;
    });

    if (!reset) {
      const current = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', jobId);
      if (current && (current.state === 'pending' || current.state === 'running')) {
        return { ok: true, action: 'already-running', jobId, alreadyRunning: true };
      }
      return { ok: false, reason: `plan.cycle job ${jobId} was not dead at reset time — nothing resumed` };
    }

    notifyOperator('task.resumed', `Task ${taskId} resumed: plan.cycle reset to pending (${jobId})`);
    return { ok: true, action: 'plan-cycle-reset', jobId };
  }

  if (task.state === 'claimed' || task.state === 'blocked') {
    // Find the latest phase job for this task (plan.cycle, junior.dispatch, work.cycle, work.diff-review, or verify.run)
    const latestJob = db.get<BureauJobRow>(
      `SELECT * FROM bureau_jobs
       WHERE task_id = ? AND kind IN ('plan.cycle', 'junior.dispatch', 'work.cycle', 'work.diff-review', 'verify.run')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      taskId
    );

    if (!latestJob) {
      return { ok: false, reason: `No dispatch or cycle job exists for task ${taskId}` };
    }

    if (latestJob.state === 'pending' || latestJob.state === 'running') {
      return { ok: true, action: 'already-running', jobId: latestJob.id, alreadyRunning: true };
    }

    if (latestJob.state !== 'dead') {
      return { ok: false, reason: `Latest job ${latestJob.id} (${latestJob.kind}) is in state '${latestJob.state}', not dead — cannot resume` };
    }

    // Revive the exact dead job row in-place with its existing deterministic/persisted ID
    const reset = db.execTransaction(() => {
      const res = db.run(
        `UPDATE bureau_jobs
         SET state = 'pending',
             attempts = 0,
             reaped_count = 0,
             last_error = NULL,
             run_after = NULL,
             lease_owner = NULL,
             lease_expires_at = NULL,
             started_at = NULL,
             finished_at = NULL
         WHERE id = ? AND state = 'dead'`,
        latestJob.id
      );
      if (res.changes === 0) return false;
      journal(db, {
        kind: 'human',
        attribution,
        taskId,
        jobId: latestJob.id,
        detail: {
          action: 'resume',
          target: latestJob.kind,
          outcome: 'reset',
          prior_attempts: latestJob.attempts,
          prior_error: latestJob.last_error
        }
      });
      return true;
    });

    if (!reset) {
      const current = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', latestJob.id);
      if (current && (current.state === 'pending' || current.state === 'running')) {
        return { ok: true, action: 'already-running', jobId: latestJob.id, alreadyRunning: true };
      }
      return { ok: false, reason: `Job ${latestJob.id} was not dead at reset time — nothing resumed` };
    }

    const action = latestJob.kind === 'junior.dispatch'
      ? 'dispatch-reset'
      : (latestJob.kind === 'plan.cycle' ? 'plan-cycle-reset' : 'cycle-reset');
    notifyOperator('task.resumed', `Task ${taskId} resumed: ${latestJob.kind} reset to pending (${latestJob.id})`);
    return { ok: true, action, jobId: latestJob.id };
  }

  return {
    ok: false,
    reason: `Task ${taskId} is in state '${task.state}' — resume applies to queued, claimed, or blocked tasks only`
  };
}
