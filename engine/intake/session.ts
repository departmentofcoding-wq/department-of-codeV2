import type { AttributionTuple, BureauIntakeMessageRow, BureauIntakeSessionRow, DbConnection, IntakeMessageRole } from '../contract/index.ts';

export interface CreateSessionInput {
  id?: string;
  idempotencyKey?: string | null;
  title?: string | null;
  intent?: string | null;
  spec?: string | null;
  acceptance?: string | null;
  verifyCmd?: string | null;
  attribution: AttributionTuple;
}

export function createSession(db: DbConnection, input: CreateSessionInput): BureauIntakeSessionRow {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const idempotencyKey = input.idempotencyKey ?? null;

  try {
    const row = db.get<BureauIntakeSessionRow>(`
      INSERT INTO bureau_intake_sessions (
        id, state, title, intent, spec, acceptance, verify_cmd,
        verify_confirmed_at, verify_confirmed_by, idempotency_key, model_calls,
        created_at, updated_at, actor_role, provider, model, account
      ) VALUES (
        ?, 'open', ?, ?, ?, ?, ?,
        NULL, NULL, ?, 0,
        ?, ?, ?, ?, ?, ?
      )
      RETURNING *
    `,
      id,
      input.title ?? null,
      input.intent ?? null,
      input.spec ?? null,
      input.acceptance ?? null,
      input.verifyCmd ?? null,
      idempotencyKey,
      now,
      now,
      input.attribution.actor_role,
      input.attribution.provider,
      input.attribution.model,
      input.attribution.account ?? null
    );

    if (!row) {
      throw new Error('Failed to insert session row');
    }
    return row;
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint failed') || err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.message?.includes('idx_intake_sessions_idempotency')) {
      throw new Error(`Session already exists with idempotency key: ${idempotencyKey}`);
    }
    throw err;
  }
}

export function getSession(db: DbConnection, id: string): BureauIntakeSessionRow | null {
  const row = db.get<BureauIntakeSessionRow>('SELECT * FROM bureau_intake_sessions WHERE id = ?', id);
  return row ?? null;
}

export function getSessionByIdempotencyKey(db: DbConnection, key: string): BureauIntakeSessionRow | null {
  const row = db.get<BureauIntakeSessionRow>('SELECT * FROM bureau_intake_sessions WHERE idempotency_key = ?', key);
  return row ?? null;
}

export interface AppendMessageInput {
  role: IntakeMessageRole;
  content: string | Record<string, unknown>;
  attribution: AttributionTuple;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
}

export function appendIntakeMessage(db: DbConnection, sessionId: string, input: AppendMessageInput): BureauIntakeMessageRow {
  return db.execTransaction(() => {
    const session = getSession(db, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.state !== 'open') {
      if (session.state === 'filed' && input.role === 'tool') {
        // Allow tool-result appends to filed sessions to complete open tool calls on filing
      } else {
        throw new Error(`Cannot append message to session ${sessionId} in state ${session.state}`);
      }
    }

    const countRow = db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM bureau_intake_messages WHERE session_id = ?',
      sessionId
    );
    const seq = (countRow?.count ?? 0) + 1;
    const seqPadded = seq.toString().padStart(6, '0');
    const timestampMs = Date.now();
    const messageId = `msg-${timestampMs}-${seqPadded}`;
    const now = new Date().toISOString();

    const contentStr = typeof input.content === 'string'
      ? input.content
      : JSON.stringify(input.content);

    const row = db.get<BureauIntakeMessageRow>(`
      INSERT INTO bureau_intake_messages (
        id, session_id, role, content, actor_role, provider, model, account,
        tokens_in, tokens_out, latency_ms, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      RETURNING *
    `,
      messageId,
      sessionId,
      input.role,
      contentStr,
      input.attribution.actor_role,
      input.attribution.provider,
      input.attribution.model,
      input.attribution.account ?? null,
      input.tokensIn ?? null,
      input.tokensOut ?? null,
      input.latencyMs ?? null,
      now
    );

    if (!row) {
      throw new Error('Failed to insert intake message');
    }
    return row;
  });
}

export interface UpdateDraftInput {
  title?: string | null;
  intent?: string | null;
  spec?: string | null;
  acceptance?: string | null;
  verify_cmd?: string | null;
}

export function updateSessionDraft(
  db: DbConnection,
  sessionId: string,
  draft: UpdateDraftInput
): BureauIntakeSessionRow {
  return db.execTransaction(() => {
    const session = getSession(db, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.state !== 'open') {
      throw new Error(`Cannot update draft for session ${sessionId} in state ${session.state}`);
    }

    const now = new Date().toISOString();
    const newTitle = draft.title !== undefined ? draft.title : session.title;
    const newIntent = draft.intent !== undefined ? draft.intent : session.intent;
    const newSpec = draft.spec !== undefined ? draft.spec : session.spec;
    const newAcceptance = draft.acceptance !== undefined ? draft.acceptance : session.acceptance;

    const touchesVerify = 'verify_cmd' in draft;
    const newVerifyCmd = touchesVerify ? (draft.verify_cmd ?? null) : session.verify_cmd;
    const newConfirmedAt = touchesVerify ? null : session.verify_confirmed_at;
    const newConfirmedBy = touchesVerify ? null : session.verify_confirmed_by;

    const row = db.get<BureauIntakeSessionRow>(`
      UPDATE bureau_intake_sessions
      SET title = ?, intent = ?, spec = ?, acceptance = ?, verify_cmd = ?,
          verify_confirmed_at = ?, verify_confirmed_by = ?, updated_at = ?
      WHERE id = ? AND state = 'open'
      RETURNING *
    `,
      newTitle,
      newIntent,
      newSpec,
      newAcceptance,
      newVerifyCmd,
      newConfirmedAt,
      newConfirmedBy,
      now,
      sessionId
    );

    if (!row) {
      throw new Error(`Failed to update draft for session ${sessionId}`);
    }
    return row;
  });
}

export function incrementModelCalls(db: DbConnection, sessionId: string): BureauIntakeSessionRow {
  return db.execTransaction(() => {
    const session = getSession(db, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.state !== 'open') {
      throw new Error(`Cannot increment model calls for session ${sessionId} in state ${session.state}`);
    }

    const now = new Date().toISOString();
    const row = db.get<BureauIntakeSessionRow>(`
      UPDATE bureau_intake_sessions
      SET model_calls = model_calls + 1, updated_at = ?
      WHERE id = ? AND state = 'open'
      RETURNING *
    `, now, sessionId);

    if (!row) {
      throw new Error(`Failed to increment model calls for session ${sessionId}`);
    }
    return row;
  });
}
