import { formatActor, isVacuousVerify, type AttributionTuple, type BureauIntakeSessionRow, type DbConnection } from '../contract/index.ts';
import { journal } from '../journal/writer.ts';
import { getSession } from './session.ts';

export function confirmVerify(
  db: DbConnection,
  sessionId: string,
  attribution: AttributionTuple
): BureauIntakeSessionRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error(`Only human-operator can confirm verify command (got '${attribution.actor_role}')`);
  }

  return db.execTransaction(() => {
    const session = getSession(db, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.state !== 'open') {
      throw new Error(`Cannot confirm verify command for session ${sessionId} in state ${session.state}`);
    }

    if (!session.verify_cmd || isVacuousVerify(session.verify_cmd)) {
      throw new Error(`Cannot confirm empty or vacuous verify command: '${session.verify_cmd ?? ''}'`);
    }

    const now = new Date().toISOString();
    const confirmedBy = formatActor(attribution);

    const updatedSession = db.get<BureauIntakeSessionRow>(`
      UPDATE bureau_intake_sessions
      SET verify_confirmed_at = ?, verify_confirmed_by = ?, updated_at = ?
      WHERE id = ? AND state = 'open'
      RETURNING *
    `, now, confirmedBy, now, sessionId);

    if (!updatedSession) {
      throw new Error(`Failed to confirm verify command for session ${sessionId}`);
    }

    journal(db, {
      kind: 'human',
      attribution,
      detail: { action: 'confirm-verify', sessionId }
    });

    return updatedSession;
  });
}
