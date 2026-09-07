import { SPAN_KINDS } from '../contract/constants.ts';
import type { AttributionTuple, BureauJournalRow, DbConnection, SpanKind } from '../contract/index.ts';
import { redactOutput } from '../contract/tools.ts';

export const MAX_JOURNAL_STRING_CHARS = 50_000;

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
 * Recursively walk object/array leaves to truncate oversized strings and scrub secrets.
 */
function sanitizeLeaf(val: unknown, maxChars: number = MAX_JOURNAL_STRING_CHARS, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof val === 'string') {
    let str = val;
    if (str.length > maxChars) {
      str = str.slice(0, maxChars) + `\n[TRUNCATED: original length ${val.length} characters]`;
    }
    return redactOutput(str);
  }
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (seen.has(val)) {
    return '[Circular]';
  }
  seen.add(val);

  if (Array.isArray(val)) {
    return val.map(item => sanitizeLeaf(item, maxChars, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) {
    result[k] = sanitizeLeaf(v, maxChars, seen);
  }
  return result;
}

/**
 * Format and sanitize the journal detail column into clean JSON string.
 */
function serializeDetail(detail: unknown): string {
  if (detail === undefined || detail === null) {
    return JSON.stringify({});
  }

  if (typeof detail === 'string') {
    const trimmed = detail.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const sanitized = sanitizeLeaf(parsed);
        return JSON.stringify(sanitized);
      } catch {
        // Fall through to plain string handling
      }
    }
    const sanitizedStr = sanitizeLeaf(detail);
    return typeof sanitizedStr === 'string' ? sanitizedStr : JSON.stringify(sanitizedStr);
  }

  const sanitized = sanitizeLeaf(detail);
  return JSON.stringify(sanitized ?? {});
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
  const detailJson = serializeDetail(span.detail);

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
