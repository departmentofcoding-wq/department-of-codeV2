import { SPAN_KINDS } from '../contract/constants.ts';
import type { AttributionTuple, BureauJournalRow, DbConnection, SpanKind } from '../contract/index.ts';

export interface JournalSpanInput {
  kind: SpanKind;
  attribution: AttributionTuple;
  taskId?: string | null;
  workUuid?: string | null;
  workTitle?: string | null;
  jobId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  detail?: Record<string, unknown> | string;
}

/**
 * The one door into the journal. Every act in the department — transitions,
 * approvals, job lifecycle, model calls — goes through here, so attribution
 * validation, kind validation, and work-session backfill cannot be bypassed.
 */
export function journal(db: DbConnection, span: JournalSpanInput): BureauJournalRow {
  if (!span.attribution) {
    throw new Error('Journal entry requires attribution tuple');
  }

  const { actor_role, provider, model, account } = span.attribution;

  if (!actor_role || !provider || !model) {
    throw new Error('Journal entry missing required attribution fields (actor_role, provider, model)');
  }

  // The journal is append-only: a misspelled kind would be wrong forever.
  // TypeScript narrows this at compile time; the guard is for JS callers.
  if (!(SPAN_KINDS as readonly string[]).includes(span.kind)) {
    throw new Error(`Journal entry kind '${String(span.kind)}' is not one of: ${SPAN_KINDS.join(', ')}`);
  }

  let finalWorkUuid = span.workUuid ?? null;
  let finalWorkTitle = span.workTitle ?? null;

  if (span.taskId && (!finalWorkUuid || !finalWorkTitle)) {
    const task = db.get<{ work_uuid: string; work_title: string | null }>(
      'SELECT work_uuid, work_title FROM bureau_tasks WHERE id = ?',
      span.taskId
    );
    if (task) {
      if (!finalWorkUuid) finalWorkUuid = task.work_uuid;
      if (!finalWorkTitle) finalWorkTitle = task.work_title;
    }
  }

  const ts = new Date().toISOString();
  const detailJson = typeof span.detail === 'string'
    ? span.detail
    : JSON.stringify(span.detail ?? {});

  const row = db.get<BureauJournalRow>(`
    INSERT INTO bureau_journal (
      ts, kind, actor_role, provider, model, account,
      task_id, work_uuid, work_title, job_id,
      tokens_in, tokens_out, cost_usd, latency_ms, detail
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    RETURNING *
  `,
    ts,
    span.kind,
    actor_role,
    provider,
    model,
    account ?? null,
    span.taskId ?? null,
    finalWorkUuid,
    finalWorkTitle,
    span.jobId ?? null,
    span.tokensIn ?? null,
    span.tokensOut ?? null,
    span.costUsd ?? null,
    span.latencyMs ?? null,
    detailJson
  );

  if (!row) {
    throw new Error('Journal insert returned no row');
  }
  return row;
}
