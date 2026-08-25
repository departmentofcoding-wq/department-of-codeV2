import { TRANSITIONS, type ActorRole, type JobKind, type TaskState } from '../contract/constants.ts';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { formatActor } from '../contract/validation.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { notifyTaskStateChange } from './notifications.ts';
import { NOTIFYING_TASK_STATES } from '../notifications/events.ts';

const ROLE_GATED_TRANSITIONS: Record<string, readonly ActorRole[]> = {
  'claimed->blocked': ['senior-engineer'],
  'verifying->claimed': ['verifier'],
  'verifying->blocked': ['verifier'],
  'blocked->claimed': ['human-operator'],
  'needs-review->done': ['human-operator', 'system']
};

export function canTransition(fromState: TaskState, toState: TaskState, actorRole: ActorRole): boolean {
  const allowed = TRANSITIONS[fromState];
  if (!allowed || !allowed.includes(toState)) {
    return false;
  }
  const key = `${fromState}->${toState}`;
  const requiredRoles = ROLE_GATED_TRANSITIONS[key];
  if (requiredRoles && !requiredRoles.includes(actorRole)) {
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

  const updatedTask = db.execTransaction(() => {
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

    const updated = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET state = ?, updated_at = ?
      WHERE id = ? AND state = ?
      RETURNING *
    `, toState, now, taskId, task.state);

    if (!updated) {
      throw new Error(`Task ${taskId} changed state concurrently; refusing to overwrite`);
    }

    journal(db, {
      kind: 'transition',
      attribution,
      taskId,
      detail: detail ?? { fromState: task.state, toState }
    });

    return updated;
  });

  if (NOTIFYING_TASK_STATES.has(toState)) {
    const reason = (detail?.reason as string) || (detail?.action as string) || undefined;
    notifyTaskStateChange(db, {
      taskId: updatedTask.id,
      title: updatedTask.title,
      state: toState,
      reason
    }).catch(() => {
      // Notification errors are non-blocking and already logged
    });
  }

  return updatedTask;
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
  const approvedBy = formatActor(attribution);

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

    if (task.verifier_exit_code !== 0) {
      throw new Error(`Task ${taskId} cannot be approved because verifier exit code is ${task.verifier_exit_code} (must be 0)`);
    }

    // Idempotent re-approval: if already approved, return task without error or re-enqueue
    if (task.approved_at !== null && task.approved_by !== null) {
      return task;
    }

    const updatedTask = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET approved_at = ?, approved_by = ?, updated_at = ?
      WHERE id = ? AND state = 'needs-review' AND approved_at IS NULL
      RETURNING *
    `, now, approvedBy, now, taskId);

    if (!updatedTask) {
      throw new Error(`Task ${taskId} changed state or was approved concurrently; refusing to approve twice`);
    }

    enqueueJob(db, {
      kind: 'pr.create',
      task_id: taskId,
      payload: { taskId }
    });

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail: { action: 'approve', approvedBy }
    });

    return updatedTask;
  });
}

/**
 * rearmTask is the single-writer for re-arming fix budgets on blocked tasks.
 * Resets verify_fixes counter to 0, transitions state blocked -> claimed,
 * enqueues verify.run job, and writes human journal span inside a single transaction.
 */
export function rearmTask(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple,
  options?: { reenqueueKind?: JobKind }
): BureauTaskRow {
  if (attribution.actor_role !== 'human-operator') {
    throw new Error('Task re-arm requires human-operator role');
  }

  const now = new Date().toISOString();
  const rearmedBy = formatActor(attribution);
  const reenqueueKind = options?.reenqueueKind ?? 'verify.run';

  return db.execTransaction(() => {
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.state !== 'blocked') {
      throw new Error(`Task ${taskId} cannot be re-armed from state ${task.state} (must be blocked)`);
    }

    const updatedTask = db.get<BureauTaskRow>(`
      UPDATE bureau_tasks
      SET state = 'claimed', verify_fixes = 0, updated_at = ?
      WHERE id = ? AND state = 'blocked'
      RETURNING *
    `, now, taskId);

    if (!updatedTask) {
      throw new Error(`Task ${taskId} changed state concurrently; refusing to re-arm twice`);
    }

    enqueueJob(db, {
      kind: reenqueueKind,
      task_id: taskId,
      payload: { taskId }
    });

    const detail: Record<string, unknown> = { action: 'rearm', rearmedBy };
    if (options?.reenqueueKind) {
      detail.reenqueueKind = options.reenqueueKind;
    }

    journal(db, {
      kind: 'human',
      attribution,
      taskId,
      detail
    });

    return updatedTask;
  });
}

