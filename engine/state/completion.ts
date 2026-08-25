import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { formatActor } from '../contract/validation.ts';
import { journal } from '../journal/writer.ts';

/**
 * Completion is a TAG the operator applies to a task they consider finished /
 * shipped — most importantly work that was delivered out-of-band via the Senior
 * review+merge path, whose DB row never travelled the verify/approve door and so
 * can never legitimately be a state-machine `done`. Like archive, completion is
 * ORTHOGONAL to `state`: it records completed_at/by + the shipping commit + a
 * note WITHOUT writing `state`, so the done-gate CHECK (done requires verifier
 * exit 0 + human approval) stays absolute — completion never forges a `done`.
 *
 * A completed task reads as "Completed / Done ✓" in the console and drops out of
 * the live/active list. Both writers are human-operator-gated, journaled, and
 * idempotent.
 */

export interface CompletionDetails {
  /** The commit/hash the work shipped in, when known (e.g. a merge commit). */
  commit?: string;
  /** Free-text note about how/why it is complete. */
  note?: string;
}

export function markTaskCompleted(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple,
  details: CompletionDetails = {}
): BureauTaskRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error('Marking a task completed requires human-operator role');
  }

  const now = new Date().toISOString();
  const completedBy = formatActor(attribution);
  const commit = details.commit && details.commit.trim() ? details.commit.trim() : null;
  const note = details.note && details.note.trim() ? details.note.trim() : null;

  return db.execTransaction(() => {
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Idempotent: already completed → return as-is, no second journal span.
    if (task.completed_at !== null) {
      return task;
    }

    const updated = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET completed_at = ?, completed_by = ?, completion_commit = ?, completion_note = ?, updated_at = ?
      WHERE id = ? AND completed_at IS NULL
      RETURNING *
    `, now, completedBy, commit, note, now, taskId);

    if (!updated) {
      throw new Error(`Task ${taskId} was completed concurrently; refusing to complete twice`);
    }

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail: { action: 'complete', completedBy, commit, note, priorState: task.state }
    });

    return updated;
  });
}

export function reopenTask(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple
): BureauTaskRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error('Reopening a task requires human-operator role');
  }

  const now = new Date().toISOString();
  const reopenedBy = formatActor(attribution);

  return db.execTransaction(() => {
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Idempotent: not completed → return as-is.
    if (task.completed_at === null) {
      return task;
    }

    const updated = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET completed_at = NULL, completed_by = NULL, completion_commit = NULL, completion_note = NULL, updated_at = ?
      WHERE id = ? AND completed_at IS NOT NULL
      RETURNING *
    `, now, taskId);

    if (!updated) {
      throw new Error(`Task ${taskId} was reopened concurrently; refusing to reopen twice`);
    }

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail: { action: 'reopen', reopenedBy }
    });

    return updated;
  });
}
