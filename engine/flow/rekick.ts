import type { AttributionTuple, BureauJobRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { planCycleJobId } from '../jobs/ids.ts';

/**
 * The operator's recovery door for a stranded flow.
 *
 * When a `plan.cycle` or `junior.dispatch` job dies (harness cold-start races,
 * a downed junior, a reaped-then-dead lease), the task row is left `queued`/
 * `claimed` with no machinery that will ever move it again: the reconciler
 * deliberately does not retry failed cycles, and dispatch payloads have no
 * enqueue-door once their job row is dead. Until now the only recovery was a
 * hand-run node script (the 2026-08-27 resume of task 1429a7de). This helper
 * productizes that runbook as a journaled, attributed, idempotent act.
 *
 * Rules (fail-closed, same spirit as every other door):
 * - `queued` task → the plan cycle may be re-kicked. The deterministic
 *   `plan.cycle:<taskId>` row is RESET (not duplicated) when dead, preserving
 *   the id contract the filing door and reconciler coordinate through; when no
 *   row exists at all a fresh one is enqueued.
 * - `claimed` task → the latest `junior.dispatch` may be re-enqueued with its
 *   stored payload verbatim (a new job id; dispatch ids are not deterministic)
 *   only when that dispatch is dead.
 * - A live (pending/running) target job is NEVER touched — that is the guard
 *   against double-prompting a GUI agent, and it is what the dead-state SQL
 *   predicates enforce atomically.
 * - Any other task state is refused: the door exists to revive dead work, not
 *   to redirect live state machines.
 */

export type RekickResult =
  | { ok: true; action: 'plan-cycle-reset' | 'plan-cycle-enqueued' | 'dispatch-reenqueued'; jobId: string }
  | { ok: false; reason: string };

export function rekickTaskFlow(db: DbConnection, taskId: string, attribution: AttributionTuple): RekickResult {
  const task = db.get<{ state: string }>('SELECT state FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) return { ok: false, reason: `Task ${taskId} not found` };

  if (task.state === 'queued') {
    const jobId = planCycleJobId(taskId);
    const existing = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);

    if (!existing) {
      // No cycle row at all (e.g. the filing door died before kickoff): the
      // reconciler's own case — enqueue exactly the way it would.
      const job = enqueueJob(db, {
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
        detail: { action: 'rekick', target: 'plan.cycle', outcome: 'enqueued' }
      });
      return { ok: true, action: 'plan-cycle-enqueued', jobId: job.id };
    }

    if (existing.state !== 'dead') {
      return { ok: false, reason: `plan.cycle job ${jobId} is ${existing.state}, not dead — nothing to re-kick` };
    }

    // RESET the dead row, keeping the deterministic id (the filing door and
    // reconciler coordinate through it) and the audit trail (the journal keeps
    // the original failure spans; this reset is itself journaled below).
    const now = new Date().toISOString();
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
          action: 'rekick',
          target: 'plan.cycle',
          outcome: 'reset',
          prior_attempts: existing.attempts,
          prior_error: existing.last_error
        }
      });
      return true;
    });
    if (!reset) {
      return { ok: false, reason: `plan.cycle job ${jobId} was not dead at reset time — nothing re-kicked` };
    }
    return { ok: true, action: 'plan-cycle-reset', jobId };
  }

  if (task.state === 'claimed') {
    const dispatch = db.get<BureauJobRow>(
      `SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      taskId
    );
    if (!dispatch) {
      return { ok: false, reason: `No junior.dispatch job exists for task ${taskId}` };
    }
    if (dispatch.state !== 'dead') {
      return { ok: false, reason: `Latest junior.dispatch job is ${dispatch.state}, not dead — nothing to re-kick` };
    }

    // Re-enqueue the IDENTICAL payload under a new id (dispatch ids are uuids,
    // so there is no id contract to preserve) — the exact manual path the
    // operator used on 2026-08-27, now journaled as a door.
    let payload: Record<string, unknown>;
    try {
      payload = dispatch.payload ? JSON.parse(dispatch.payload) : {};
    } catch {
      return { ok: false, reason: `Dead dispatch ${dispatch.id} payload is not valid JSON — cannot re-enqueue` };
    }
    const job = enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: taskId,
      payload,
      max_attempts: dispatch.max_attempts
    });
    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      jobId: job.id,
      detail: { action: 'rekick', target: 'junior.dispatch', outcome: 'reenqueued', fromJobId: dispatch.id }
    });
    return { ok: true, action: 'dispatch-reenqueued', jobId: job.id };
  }

  return {
    ok: false,
    reason: `Task ${taskId} is in state ${task.state} — re-kick applies to queued (plan cycle) or claimed (dispatch) tasks only`
  };
}
