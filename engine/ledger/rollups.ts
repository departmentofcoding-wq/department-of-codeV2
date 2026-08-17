import type { DbConnection } from '../contract/index.ts';

export interface ModelAttributionRollup {
  model: string;
  provider: string;
  acts: number;
  tasks_touched: number;
  jobs_run: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  /** False when no span carried a cost — "not recorded", which is not "$0". */
  cost_recorded: boolean;
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

export function getModelAttributionRollups(db: DbConnection): ModelAttributionRollup[] {
  const stmt = db.prepare(`
    SELECT
      model,
      provider,
      COUNT(*) AS acts,
      COUNT(DISTINCT task_id) AS tasks_touched,
      COUNT(DISTINCT job_id) AS jobs_run,
      COALESCE(SUM(tokens_in), 0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(cost_usd), 0.0) AS cost_usd,
      COUNT(cost_usd) AS cost_spans,
      AVG(latency_ms) AS avg_latency_ms,
      MIN(ts) AS first_seen,
      MAX(ts) AS last_seen
    FROM bureau_journal
    GROUP BY model, provider
    ORDER BY model ASC
  `);

  const rows = stmt.all() as any[];
  return rows.map(r => ({
    model: r.model,
    provider: r.provider,
    acts: Number(r.acts),
    tasks_touched: Number(r.tasks_touched),
    jobs_run: Number(r.jobs_run),
    tokens_in: Number(r.tokens_in),
    tokens_out: Number(r.tokens_out),
    cost_usd: Number(r.cost_usd),
    cost_recorded: Number(r.cost_spans) > 0,
    avg_latency_ms: r.avg_latency_ms !== null ? Number(r.avg_latency_ms) : null,
    first_seen: r.first_seen,
    last_seen: r.last_seen
  }));
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
