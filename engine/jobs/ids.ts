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

/**
 * R2 (2026-09-08 incident): the successor round of a plan cycle enqueues with a
 * deterministic per-(task, round) id so a FORKED cycle lineage cannot mint two
 * live successors for the same round — one job previously emitted two review
 * rounds and each minted a random-id successor; both lineages approved plans
 * and each dispatched an implementation (the duplicate-dispatch incident).
 */
export function planCycleRoundJobId(taskId: string, round: number): string {
  return `plan.cycle:${taskId}:r${round}`;
}

/**
 * R2: the implementation dispatch a plan cycle enqueues (approve path and
 * ceiling-proceed path) is keyed on the TASK, not the plan — a surviving fork
 * that approves a DIFFERENT plan must still collapse to ONE live
 * implementation dispatch per task. Recovery doors (rekick etc.) mint fresh
 * random ids, so a dead deterministic dispatch never blocks an operator
 * re-drive.
 */
export function implementationDispatchJobId(taskId: string): string {
  return `junior.dispatch:impl:${taskId}`;
}

/** The bureau_dispatches row id paired with {@link implementationDispatchJobId}. */
export function implementationDispatchRowId(taskId: string): string {
  return `impl:${taskId}`;
}

/** The deterministic project.provision job id for a canonical project name. */
export function projectProvisionJobId(canonicalName: string): string {
  return `project.provision:${canonicalName.toLowerCase().trim()}`;
}

