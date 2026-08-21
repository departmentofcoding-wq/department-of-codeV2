import type { DbConnection } from '../contract/index.ts';
import { enqueueJobIfAbsent } from '../jobs/jobs.ts';
import { planCycleJobId } from '../jobs/ids.ts';

/**
 * Self-healing safety net for the auto-kickoff flow.
 *
 * The filing door (engine/filing/file_task.ts) already enqueues a plan.cycle
 * when a task is filed, but a task can reach `queued` with no cycle behind it:
 * it was filed while no runner was up, or an operator poked the state by hand.
 * Any runner that comes up sweeps those stranded tasks in.
 *
 * The enqueue is keyed on the same deterministic id the filing door uses, via
 * INSERT OR IGNORE, so this composes with the filing door and can never
 * double-file. The `NOT EXISTS` guard keeps it bounded: it fires only for tasks
 * with ZERO plan.cycle job, so a cycle that already ran and failed (plan.cycle
 * is deliberately maxAttempts:1) is NOT retried in a loop — re-running a failed
 * cycle stays an explicit operator action.
 *
 * @returns the task ids for which a fresh plan.cycle was enqueued this sweep.
 */
export function reconcileQueuedTasks(db: DbConnection): string[] {
  const stranded = db.all<{ id: string }>(
    `SELECT t.id FROM bureau_tasks t
     WHERE t.state = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM bureau_jobs j
         WHERE j.task_id = t.id AND j.kind = 'plan.cycle'
       )`
  );

  const enqueued: string[] = [];
  for (const { id: taskId } of stranded) {
    const { inserted } = enqueueJobIfAbsent(db, {
      id: planCycleJobId(taskId),
      kind: 'plan.cycle',
      task_id: taskId,
      payload: { taskId },
      max_attempts: 1
    });
    if (inserted) {
      enqueued.push(taskId);
    }
  }
  return enqueued;
}
