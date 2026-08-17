import { TRANSITIONS, type ActorRole, type TaskState } from '../contract/constants.ts';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';

export function canTransition(fromState: TaskState, toState: TaskState, actorRole: ActorRole): boolean {
  const allowed = TRANSITIONS[fromState];
  if (!allowed || !allowed.includes(toState)) {
    return false;
  }
  if (toState === 'done' && actorRole !== 'human-operator') {
    return false;
  }
  return true;
}

export function transition(
  db: DbConnection,
  taskId: string,
  toState: TaskState,
  attribution: AttributionTuple,
  detail?: Record<string, unknown>
): BureauTaskRow {
  const now = new Date().toISOString();

  return db.execTransaction(() => {
    // The read, the validation, and the write share one write-locked
    // transaction: no other connection can move the state between the check
    // and the UPDATE. The state predicate on the UPDATE is belt-and-braces
    // for the day someone refactors the read back out.
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (!canTransition(task.state, toState, attribution.actor_role)) {
      throw new Error(`Illegal state transition from ${task.state} to ${toState} by role ${attribution.actor_role}`);
    }

    const updatedTask = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET state = ?, updated_at = ?
      WHERE id = ? AND state = ?
      RETURNING *
    `, toState, now, taskId, task.state);

    if (!updatedTask) {
      throw new Error(`Task ${taskId} changed state concurrently; refusing to overwrite`);
    }

    journal(db, {
      kind: 'transition',
      attribution,
      taskId,
      detail: detail ?? { fromState: task.state, toState }
    });

    return updatedTask;
  });
}

/**
 * approveTask is the single-writer for approved_at and approved_by in the entire codebase.
 */
export function approveTask(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple
): BureauTaskRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error('Task approval requires human-operator role');
  }

  const now = new Date().toISOString();
  const approvedBy = attribution.account ? `${attribution.actor_role}:${attribution.account}` : attribution.actor_role;

  return db.execTransaction(() => {
    // State re-checked inside the write-locked transaction, and the UPDATE is
    // state-guarded: a second approval racing the first must refuse, not
    // double-write. The database CHECK remains the floor beneath all of it.
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.state !== 'needs-review') {
      throw new Error(`Task ${taskId} cannot be approved from state ${task.state} (must be needs-review)`);
    }

    const updatedTask = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET state = 'done', approved_at = ?, approved_by = ?, updated_at = ?
      WHERE id = ? AND state = 'needs-review'
      RETURNING *
    `, now, approvedBy, now, taskId);

    if (!updatedTask) {
      throw new Error(`Task ${taskId} changed state concurrently; refusing to approve twice`);
    }

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail: { action: 'approve', approvedBy }
    });

    return updatedTask;
  });
}
