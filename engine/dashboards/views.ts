import type { DbConnection } from '../contract/index.ts';

/**
 * Read-only projections over the journal and task tables — the Operator's
 * window into the department's health. Milestone B2.
 *
 * Every function here is a pure SELECT: no INSERT/UPDATE/DELETE, no job
 * enqueue, no network. T49 proves the read-only contract by snapshotting row
 * counts before and after a full dashboard render and asserting equality.
 */

export interface StatePopulation {
  state: string;
  count: number;
}

export interface TaskBudgetSpend {
  task_id: string;
  title: string;
  state: string;
  plan_rounds: number;
  verify_fixes: number;
  cycles: number;
  attempts: number;
  recover_attempts: number;
}

export interface VerifyFailureRate {
  total_runs: number;
  failures: number;
  failure_rate: number; // 0..1, 0 when there are no runs
}

export interface SpanKindCount {
  kind: string;
  count: number;
}

export interface DashboardSnapshot {
  statePopulations: StatePopulation[];
  budgetSpend: TaskBudgetSpend[];
  verifyFailureRate: VerifyFailureRate;
  spanKindCounts: SpanKindCount[];
  guardrailCount: number;
}

/** Task counts grouped by state — how much work sits where. */
export function statePopulations(db: DbConnection): StatePopulation[] {
  return db.all<StatePopulation>(
    `SELECT state, COUNT(*) AS count FROM bureau_tasks GROUP BY state ORDER BY count DESC, state ASC`
  );
}

/** Per-task budget spend — the columns that bound every async loop. */
export function budgetSpend(db: DbConnection): TaskBudgetSpend[] {
  return db.all<TaskBudgetSpend>(
    `SELECT id AS task_id, title, state,
            plan_rounds, verify_fixes, cycles, attempts, recover_attempts
     FROM bureau_tasks
     ORDER BY (plan_rounds + verify_fixes + cycles + attempts + recover_attempts) DESC, id ASC`
  );
}

/** Verifier failure rate over all recorded runs (exit code <> 0 is a failure). */
export function verifyFailureRate(db: DbConnection): VerifyFailureRate {
  const row = db.get<{ total_runs: number; failures: number }>(
    `SELECT COUNT(*) AS total_runs,
            COALESCE(SUM(CASE WHEN exit_code <> 0 THEN 1 ELSE 0 END), 0) AS failures
     FROM bureau_verify_runs`
  );
  const total = row?.total_runs ?? 0;
  const failures = row?.failures ?? 0;
  return {
    total_runs: total,
    failures,
    failure_rate: total === 0 ? 0 : failures / total
  };
}

/** Journal span populations by kind — where the department spends its acts. */
export function spanKindCounts(db: DbConnection): SpanKindCount[] {
  return db.all<SpanKindCount>(
    `SELECT kind, COUNT(*) AS count FROM bureau_journal GROUP BY kind ORDER BY count DESC, kind ASC`
  );
}

/** Guardrail spans — every refused act. A rising number is the watchdog/red-team working. */
export function guardrailCount(db: DbConnection): number {
  const row = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM bureau_journal WHERE kind = 'guardrail'`
  );
  return row?.count ?? 0;
}

/** One read-only pass assembling the whole dashboard. */
export function dashboardSnapshot(db: DbConnection): DashboardSnapshot {
  return {
    statePopulations: statePopulations(db),
    budgetSpend: budgetSpend(db),
    verifyFailureRate: verifyFailureRate(db),
    spanKindCounts: spanKindCounts(db),
    guardrailCount: guardrailCount(db)
  };
}
