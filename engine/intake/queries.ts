import { isVacuousVerify, type BureauIntakeMessageRow, type BureauIntakeSessionRow, type DbConnection } from '../contract/index.ts';

export function getOpenSessions(db: DbConnection): BureauIntakeSessionRow[] {
  return db.all<BureauIntakeSessionRow>(
    `SELECT * FROM bureau_intake_sessions WHERE state = 'open' ORDER BY created_at DESC`
  );
}

export function getSessionsAwaitingConfirmation(db: DbConnection): BureauIntakeSessionRow[] {
  const openCandidates = db.all<BureauIntakeSessionRow>(
    `SELECT * FROM bureau_intake_sessions
     WHERE state = 'open'
       AND verify_cmd IS NOT NULL
       AND verify_cmd != ''
       AND verify_confirmed_at IS NULL
     ORDER BY created_at DESC`
  );

  return openCandidates.filter((s) => !isVacuousVerify(s.verify_cmd));
}

export interface SessionWithMessages {
  session: BureauIntakeSessionRow;
  messages: BureauIntakeMessageRow[];
}

export function getSessionWithMessages(db: DbConnection, sessionId: string): SessionWithMessages | null {
  const session = db.get<BureauIntakeSessionRow>(
    'SELECT * FROM bureau_intake_sessions WHERE id = ?',
    sessionId
  );

  if (!session) {
    return null;
  }

  const messages = db.all<BureauIntakeMessageRow>(
    `SELECT * FROM bureau_intake_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
    sessionId
  );

  return { session, messages };
}
