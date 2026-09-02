import type { DbConnection } from '../contract/index.ts';
import { enqueueJobIfAbsent } from '../jobs/jobs.ts';
import { planCycleJobId } from '../jobs/ids.ts';
import { DEFAULT_PLAN_ROUNDS_CEILING, REVIEW_PR_META_KEYS } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';
import { ensureTaskAssignment, juniorIsOccupied, freeJuniors } from './assignment.ts';

/**
 * N17 — the department's task queue manager (evolved from the plain
 * stranded-task reconciler).
 *
 * Filed tasks are born `queued` and WAIT HERE. A task is admitted — assigned a
 * junior + senior (the claim-time pin, `engine/flow/assignment.ts`) and handed
 * its deterministic `plan.cycle` job — only when a junior has capacity. With
 * two juniors in the roster at most two tasks are in flight at any moment;
 * five filed tasks form a neat FIFO queue (created_at order) instead of all
 * being claimed at once and colliding on the junior windows (the 2026-09-02
 * incident).
 *
 * Admission rules (fail-closed, same spirit as the old reconciler):
 * - Candidate: `queued`, unarchived, UNASSIGNED, rounds below the plan
 *   ceiling, with no live (pending/running) plan.cycle.
 * - A junior must be FREE (see `juniorIsOccupied`). None free → admit nothing
 *   this sweep; the queue just waits (no journal spam, no claim churn).
 * - Fresh enqueue uses the filing door's deterministic id (`INSERT OR IGNORE`),
 *   so this composes with every other door and can never double-file.
 * - The operator-action rule for FAILED cycles is unchanged: a DEAD cycle row
 *   is never retried here. The single exception is the capacity-defer
 *   signature — a `done` cycle row on a still-unassigned, round-0 task (the
 *   plan-cycle handler deferring for capacity, having done no agent work) —
 *   which is RESET to pending, exactly once, when capacity exists.
 *
 * @returns the task ids admitted this sweep, in queue order.
 */
export function reconcileQueuedTasks(db: DbConnection): string[] {
  const ceilingRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.REVIEW_PLAN_ROUNDS_CEILING
  );
  const ceiling = ceilingRow ? parseInt(ceilingRow.value, 10) : DEFAULT_PLAN_ROUNDS_CEILING;

  const candidates = db.all<{ id: string }>(
    `SELECT t.id FROM bureau_tasks t
     WHERE t.state = 'queued'
       AND t.archived_at IS NULL
       AND t.assigned_junior IS NULL
       AND t.plan_rounds < ?
       AND NOT EXISTS (
         SELECT 1 FROM bureau_jobs j
         WHERE j.task_id = t.id AND j.kind = 'plan.cycle'
           AND j.state IN ('pending','running')
       )
     ORDER BY t.created_at ASC, t.id ASC`,
    Number.isFinite(ceiling) ? ceiling : DEFAULT_PLAN_ROUNDS_CEILING
  );

  const admitted: string[] = [];
  for (const { id: taskId } of candidates) {
    // Capacity first: stop at the first task no junior is free for. The queue
    // is FIFO — a busy roster must not let task 5 leapfrog task 3.
    const free = freeJuniors().filter(j => !juniorIsOccupied(db, j));
    if (free.length === 0) break;

    const jobId = planCycleJobId(taskId);

    // Operator-action rule check BEFORE assigning — a task we will not admit
    // must not consume a junior pin either.
    //   - a DEAD cycle row is never retried here (explicit operator action),
    //   - the single exception is the capacity-defer signature: a `done` cycle
    //     row on a still-unassigned, round-0 task (the plan-cycle handler
    //     deferring for capacity, having done no agent work) — reset it.
    const existing = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', jobId);
    let resetDeferredCycle = false;
    if (existing) {
      if (existing.state !== 'done') continue;
      const rounds = db.get<{ plan_rounds: number }>(
        'SELECT plan_rounds FROM bureau_tasks WHERE id = ?',
        taskId
      );
      if (!rounds || rounds.plan_rounds > 0) continue;
      resetDeferredCycle = true;
    }

    // Claim-time assignment: pin junior + senior, once, transactionally.
    // (No jobId on the span: the assignment precedes the cycle-row insert, and
    // the journal's job FK demands a real row — the taskId identifies the act.)
    const ensured = ensureTaskAssignment(db, taskId);
    if (ensured.status !== 'assigned') break;

    if (resetDeferredCycle) {
      const reset = db.execTransaction(() => {
        const res = db.run(
          `UPDATE bureau_jobs
           SET state = 'pending', attempts = 0, reaped_count = 0, last_error = NULL,
               run_after = NULL, lease_owner = NULL, lease_expires_at = NULL,
               started_at = NULL, finished_at = NULL
           WHERE id = ? AND state = 'done'`,
          jobId
        );
        if (res.changes === 0) return false;
        journal(db, {
          kind: 'system',
          attribution: { actor_role: 'system', provider: 'deterministic', model: 'queue-policy', account: null },
          taskId,
          jobId,
          detail: { action: 'flow_admit_requeue', reason: 'capacity_defer_cycle_reset' }
        });
        return true;
      });
      if (reset) admitted.push(taskId);
      continue;
    }

    const { inserted } = enqueueJobIfAbsent(db, {
      id: jobId,
      kind: 'plan.cycle',
      task_id: taskId,
      payload: { taskId },
      max_attempts: 1
    });
    if (inserted) {
      admitted.push(taskId);
    }
  }
  return admitted;
}
