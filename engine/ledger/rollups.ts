import type { DbConnection } from '../contract/index.ts';
import { getModelPrice, costOf } from './pricing.ts';

/** How a rollup's dollar figure was arrived at (A5). */
export type CostBasis =
  | 'none'      // no tokens/cost at all
  | 'recorded'  // every dollar came from a span that carried cost_usd
  | 'computed'  // dollars derived from tokens × the model's price
  | 'mixed'     // some recorded, some computed
  | 'unpriced'; // tokens were spent but the model has no price — cost UNKNOWN, not $0

export interface ModelAttributionRollup {
  model: string;
  provider: string;
  acts: number;
  tasks_touched: number;
  jobs_run: number;
  tokens_in: number;
  tokens_out: number;
  /** Dollars that spans actually carried (unchanged, back-compat). */
  cost_usd: number;
  /** False when no span carried a cost — "not recorded", which is not "$0". */
  cost_recorded: boolean;
  /** Dollars derived from tokens × price for spans that carried no cost (A5). */
  computed_cost_usd: number;
  /** recorded + computed — the best available dollar estimate (A5). */
  total_cost_usd: number;
  /** Provenance of `total_cost_usd` (A5). */
  cost_basis: CostBasis;
  /** Acts that spent tokens but had neither a recorded cost nor a known price —
   *  real spend the ledger cannot value. Non-zero ⇒ `total_cost_usd` understates. */
  unpriced_acts: number;
  avg_latency_ms: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface WorkSessionCostLine {
  work_uuid: string;
  work_title: string | null;
  acts: number;
  tokens_in: number;
  tokens_out: number;
  total_cost_usd: number;
  cost_recorded: boolean;
}

/** All-time per-model attribution + cost rollup. Thin wrapper over the windowed
 *  form with no time bound — keeps the original signature for existing callers. */
export function getModelAttributionRollups(db: DbConnection): ModelAttributionRollup[] {
  return getModelAttributionRollupsWindowed(db, {});
}

export interface PeriodCostRollup {
  since: string | null;
  until: string | null;
  recorded_cost_usd: number;
  computed_cost_usd: number;
  total_cost_usd: number;
  /** Acts with real token spend the ledger could not value (no price). */
  unpriced_acts: number;
  /** True ⇒ `total_cost_usd` is a floor: some real spend is unpriced. */
  has_unpriced_spend: boolean;
  models: ModelAttributionRollup[];
}

/**
 * A monthly-style cost rollup over the live journal (A5). Rolls the per-model
 * lines into one honest total: recorded + computed dollars, plus a count of the
 * acts that spent tokens the ledger cannot price. `has_unpriced_spend` says
 * plainly when the dollar total is a floor rather than the whole bill.
 *
 * The window is applied by filtering the journal to [since, until) before
 * grouping; omit both for all-time.
 */
export function getPeriodCostRollup(
  db: DbConnection,
  opts: { sinceIso?: string; untilIso?: string } = {}
): PeriodCostRollup {
  // Reuse the per-model logic by scoping via a temporary view of the journal is
  // overkill; instead the per-model roller already reads the whole journal, so
  // when a window is requested we filter its inputs here.
  const models = getModelAttributionRollupsWindowed(db, opts);
  let recorded = 0;
  let computed = 0;
  let unpriced = 0;
  for (const m of models) {
    recorded += m.cost_usd;
    computed += m.computed_cost_usd;
    unpriced += m.unpriced_acts;
  }
  return {
    since: opts.sinceIso ?? null,
    until: opts.untilIso ?? null,
    recorded_cost_usd: recorded,
    computed_cost_usd: computed,
    total_cost_usd: recorded + computed,
    unpriced_acts: unpriced,
    has_unpriced_spend: unpriced > 0,
    models
  };
}

/** Per-model rollups optionally scoped to a time window. Same shape/semantics as
 *  `getModelAttributionRollups`; that function is this with no window. */
export function getModelAttributionRollupsWindowed(
  db: DbConnection,
  opts: { sinceIso?: string; untilIso?: string } = {}
): ModelAttributionRollup[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.sinceIso) { where.push('ts >= ?'); params.push(opts.sinceIso); }
  if (opts.untilIso) { where.push('ts < ?'); params.push(opts.untilIso); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const stmt = db.prepare(`
    SELECT
      model, provider,
      COUNT(*) AS acts,
      COUNT(DISTINCT task_id) AS tasks_touched,
      COUNT(DISTINCT job_id) AS jobs_run,
      COALESCE(SUM(tokens_in), 0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(cost_usd), 0.0) AS cost_usd,
      COUNT(cost_usd) AS cost_spans,
      COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN tokens_in ELSE 0 END), 0) AS uncosted_tokens_in,
      COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN tokens_out ELSE 0 END), 0) AS uncosted_tokens_out,
      COUNT(CASE WHEN cost_usd IS NULL AND (COALESCE(tokens_in,0) > 0 OR COALESCE(tokens_out,0) > 0) THEN 1 END) AS uncosted_token_acts,
      AVG(latency_ms) AS avg_latency_ms,
      MIN(ts) AS first_seen,
      MAX(ts) AS last_seen
    FROM bureau_journal
    ${whereSql}
    GROUP BY model, provider
    ORDER BY model ASC
  `);

  const rows = stmt.all(...params) as any[];
  return rows.map(r => {
    const recorded = Number(r.cost_usd);
    const costSpans = Number(r.cost_spans);
    const price = getModelPrice(db, r.model);
    const computed = price ? costOf(price, Number(r.uncosted_tokens_in), Number(r.uncosted_tokens_out)) : 0;
    const uncostedActs = Number(r.uncosted_token_acts);
    const unpricedActs = price ? 0 : uncostedActs;
    let basis: CostBasis;
    if (recorded === 0 && computed === 0 && uncostedActs === 0 && costSpans === 0) basis = 'none';
    else if (unpricedActs > 0 && costSpans === 0 && computed === 0) basis = 'unpriced';
    else if (costSpans > 0 && computed === 0 && unpricedActs === 0) basis = 'recorded';
    else if (costSpans === 0 && computed > 0) basis = 'computed';
    else basis = 'mixed';
    return {
      model: r.model, provider: r.provider,
      acts: Number(r.acts), tasks_touched: Number(r.tasks_touched), jobs_run: Number(r.jobs_run),
      tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      cost_usd: recorded, cost_recorded: costSpans > 0,
      computed_cost_usd: computed, total_cost_usd: recorded + computed,
      cost_basis: basis, unpriced_acts: unpricedActs,
      avg_latency_ms: r.avg_latency_ms !== null ? Number(r.avg_latency_ms) : null,
      first_seen: r.first_seen, last_seen: r.last_seen
    };
  });
}

export function getWorkSessionCostLines(db: DbConnection): WorkSessionCostLine[] {
  const stmt = db.prepare(`
    SELECT
      work_uuid,
      MAX(work_title) AS work_title,
      COUNT(*) AS acts,
      COALESCE(SUM(tokens_in), 0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
      COUNT(cost_usd) AS cost_spans
    FROM bureau_journal
    WHERE work_uuid IS NOT NULL
    GROUP BY work_uuid
    ORDER BY work_uuid ASC
  `);

  const rows = stmt.all() as any[];
  return rows.map(r => ({
    work_uuid: r.work_uuid,
    work_title: r.work_title,
    acts: Number(r.acts),
    tokens_in: Number(r.tokens_in),
    tokens_out: Number(r.tokens_out),
    total_cost_usd: Number(r.total_cost_usd),
    cost_recorded: Number(r.cost_spans) > 0
  }));
}
