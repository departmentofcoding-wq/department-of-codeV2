/**
 * Deterministic job ids for the auto-kickoff flow.
 *
 * The filing door (engine/filing/file_task.ts) and the runner's reconciler tick
 * (runner/main.ts) both want to enqueue the plan cycle for a task exactly once.
 * They coordinate through this id, not through a lock: `enqueueJobIfAbsent`
 * uses INSERT OR IGNORE on the primary key, so whichever door fires first wins
 * and every later attempt is a no-op. Keep the derivation here, in one place,
 * so the two callers can never drift apart.
 */

/** The one plan.cycle job id for a task. One task → one cycle job. */
export function planCycleJobId(taskId: string): string {
  return `plan.cycle:${taskId}`;
}
