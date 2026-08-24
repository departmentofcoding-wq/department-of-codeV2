import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { formatActor } from '../contract/validation.ts';
import { journal } from '../journal/writer.ts';

/**
 * Archiving is orthogonal to the task state machine. It records that the
 * operator has set a task aside — a test artifact that leaked into the live DB,
 * or a task that shipped out-of-band via the Senior review+merge path whose DB
 * row never travelled the verify/approve door — WITHOUT touching `state`. The
 * done-gate CHECK constraints (done requires verifier exit 0 + human approval)
 * therefore stay absolute: archiving never forges a `done`, it only hides a row
 * from the live list and files it under a reason.
 *
 * Both writers are human-operator-gated, journal an attributed span, and are
 * idempotent (re-archiving an archived task is a no-op that returns the row).
 */

export function archiveTask(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple,
  reason?: string
): BureauTaskRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error('Task archive requires human-operator role');
  }

  const now = new Date().toISOString();
  const archivedBy = formatActor(attribution);
  const cleanReason = reason && reason.trim() ? reason.trim() : null;

  return db.execTransaction(() => {
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Idempotent: already archived → return as-is, no second journal span.
    if (task.archived_at !== null) {
      return task;
    }

    const updated = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
      WHERE id = ? AND archived_at IS NULL
      RETURNING *
    `, now, archivedBy, cleanReason, now, taskId);

    if (!updated) {
      throw new Error(`Task ${taskId} was archived concurrently; refusing to archive twice`);
    }

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail: { action: 'archive', archivedBy, reason: cleanReason, priorState: task.state }
    });

    return updated;
  });
}

export function unarchiveTask(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple
): BureauTaskRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error('Task unarchive requires human-operator role');
  }

  const now = new Date().toISOString();
  const restoredBy = formatActor(attribution);

  return db.execTransaction(() => {
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Idempotent: not archived → return as-is.
    if (task.archived_at === null) {
      return task;
    }

    const updated = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, updated_at = ?
      WHERE id = ? AND archived_at IS NOT NULL
      RETURNING *
    `, now, taskId);

    if (!updated) {
      throw new Error(`Task ${taskId} was unarchived concurrently; refusing to unarchive twice`);
    }

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail: { action: 'unarchive', restoredBy }
    });

    return updated;
  });
}
