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

export interface WorkerRosterEntry {
  role: string;
  backend: string | null;
  model_id: string | null;
  provider: string | null;
  display: string | null;
  active: boolean;
  active_leases: number;
  running_dispatches: number;
  last_activity_ts: string | null;
  last_activity_kind: string | null;
}

/** How recent a journal span counts as "currently working" (ms). */
export const WORKER_ACTIVE_WINDOW_MS = 120_000;

/**
 * The department roster — every worker (role), the model/provider backing it,
 * and whether it is currently active. A worker is active if it holds a live
 * window lease, has a running dispatch, or produced a journal span within the
 * last WORKER_ACTIVE_WINDOW_MS. Read-only.
 */
export function workerRoster(db: DbConnection, nowMs: number = Date.now()): WorkerRosterEntry[] {
  // Roles come from explicit assignments plus any actor seen in the journal
  // (foreman, verifier, human-operator, system have no model assignment).
  const roles = new Set<string>();
  for (const r of db.all<{ role: string }>(`SELECT role FROM bureau_assignments`)) roles.add(r.role);
  for (const r of db.all<{ actor_role: string }>(`SELECT DISTINCT actor_role FROM bureau_journal`)) {
    if (r.actor_role) roles.add(r.actor_role);
  }

  const roster: WorkerRosterEntry[] = [];
  for (const role of [...roles].sort()) {
    const assign = db.get<{ backend: string; model_id: string | null }>(
      `SELECT backend, model_id FROM bureau_assignments WHERE role = ?`,
      role
    );
    const model = assign?.model_id
      ? db.get<{ provider: string; display: string }>(`SELECT provider, display FROM bureau_models WHERE id = ?`, assign.model_id)
      : undefined;
    const activeLeases = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bureau_window_leases WHERE actor_role = ? AND status = 'active'`,
      role
    )?.c ?? 0;
    const runningDispatches = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bureau_dispatches WHERE actor_role = ? AND status = 'running'`,
      role
    )?.c ?? 0;
    const last = db.get<{ ts: string; kind: string }>(
      `SELECT ts, kind FROM bureau_journal WHERE actor_role = ? ORDER BY id DESC LIMIT 1`,
      role
    );
    const recentlyActive = last?.ts ? nowMs - Date.parse(last.ts) <= WORKER_ACTIVE_WINDOW_MS : false;

    roster.push({
      role,
      backend: assign?.backend ?? null,
      model_id: assign?.model_id ?? null,
      provider: model?.provider ?? null,
      display: model?.display ?? null,
      active: activeLeases > 0 || runningDispatches > 0 || recentlyActive,
      active_leases: activeLeases,
      running_dispatches: runningDispatches,
      last_activity_ts: last?.ts ?? null,
      last_activity_kind: last?.kind ?? null
    });
  }
  // Active workers first, then most-recently-active.
  return roster.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.last_activity_ts ?? '').localeCompare(a.last_activity_ts ?? '');
  });
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
