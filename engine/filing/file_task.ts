import { taskGaps, type AttributionTuple, type BureauTaskRow, type DbConnection } from '../contract/index.ts';
import { getSession } from '../intake/session.ts';
import { journal } from '../journal/writer.ts';
import { enqueueJobIfAbsent } from '../jobs/jobs.ts';
import { planCycleJobId } from '../jobs/ids.ts';
import { notifyTaskStateChange } from '../state/notifications.ts';
import { NOTIFYING_TASK_STATES } from '../notifications/events.ts';

export function fileTask(
  db: DbConnection,
  sessionId: string,
  attribution: AttributionTuple
): BureauTaskRow {
  // Set only on the fresh-insert path — the idempotent re-file returns the
  // existing task and must not push a second "filed" notification.
  let insertedNewTask = false;

  const taskRow = db.execTransaction(() => {
    const session = getSession(db, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.state === 'abandoned') {
      throw new Error(`Cannot file task from abandoned session ${sessionId}`);
    }

    if (session.state === 'filed') {
      const existingTask = db.get<BureauTaskRow>(
        'SELECT * FROM bureau_tasks WHERE intake_session_id = ?',
        sessionId
      );
      if (existingTask) {
        return existingTask;
      }
      throw new Error(`Session ${sessionId} is marked as filed but no associated task was found`);
    }

    const gaps = taskGaps(session);
    if (gaps.length > 0) {
      throw new Error(`Cannot file task from session ${sessionId}: missing required gaps: ${gaps.join(', ')}`);
    }

    const now = new Date().toISOString();
    const updatedSession = db.get<{ id: string }>(`
      UPDATE bureau_intake_sessions
      SET state = 'filed', updated_at = ?
      WHERE id = ? AND state = 'open'
      RETURNING id
    `, now, sessionId);

    if (!updatedSession) {
      const reReadSession = getSession(db, sessionId);
      if (reReadSession?.state === 'filed') {
        const existingTask = db.get<BureauTaskRow>(
          'SELECT * FROM bureau_tasks WHERE intake_session_id = ?',
          sessionId
        );
        if (existingTask) {
          return existingTask;
        }
      }
      throw new Error(`Session ${sessionId} changed state concurrently; refusing to file task twice`);
    }

    const taskId = crypto.randomUUID();
    const workUuid = crypto.randomUUID();
    const workTitle = session.title!;

    const taskRow = db.get<BureauTaskRow>(`
      INSERT INTO bureau_tasks (
        id, title, project_id, intent, spec, acceptance, verify_cmd, setup_cmd,
        state, priority, work_uuid, work_title, intake_session_id,
        plan_rounds, verify_fixes, cycles, attempts, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, NULL,
        'queued', 1, ?, ?, ?,
        0, 0, 0, 0, ?, ?
      )
      RETURNING *
    `,
      taskId,
      session.title!,
      session.project_id ?? null,
      session.intent ?? null,
      session.spec ?? null,
      session.acceptance ?? null,
      session.verify_cmd ?? null,
      workUuid,
      workTitle,
      session.id,
      now,
      now
    );

    if (!taskRow) {
      throw new Error('Failed to insert task row');
    }

    insertedNewTask = true;

    journal(db, {
      kind: 'task-filed',
      attribution,
      taskId: taskRow.id,
      detail: { sessionId: session.id, idempotencyKey: session.idempotency_key }
    });

    // Auto-kickoff: a filed task is born `queued`, and the whole build flow is
    // driven by the `plan.cycle` job (junior authors → rubric gate → senior
    // reviews → dispatch → verify → work review → PR). Enqueue it here, in the
    // SAME transaction as the task insert, so there is never a filed task with
    // no work behind it. The deterministic job id makes this idempotent: a
    // re-file or a reconciler sweep can never spawn a second cycle. The cycle
    // itself defaults its junior/senior from the assignment policy, so no
    // operator arguments are required. Nothing runs until a Runner drains the
    // job — draining stays a separate door, so this never bypasses the human
    // approval + verifier-exit-0 gate that governs `done`.
    enqueueJobIfAbsent(db, {
      id: planCycleJobId(taskRow.id),
      kind: 'plan.cycle',
      task_id: taskRow.id,
      payload: { taskId: taskRow.id },
      max_attempts: 1
    });

    return taskRow;
  });

  // Filing pushes an ntfy "task filed" notification when the catalog enables
  // the queued state — fired AFTER the filing transaction commits, best-effort,
  // mirroring machine.ts's transition hook (notification failures never block
  // filing). A filed task is born `queued` via INSERT, not transition(), so
  // this is the only place the entry-to-queued push can originate.
  if (insertedNewTask && NOTIFYING_TASK_STATES.has('queued')) {
    const push = notifyTaskStateChange(db, {
      taskId: taskRow.id,
      title: taskRow.title,
      state: 'queued',
      reason: 'Task filed — entering the queue; plan kickoff follows automatically'
    })
      .catch(() => {
        // Notification errors are non-blocking and already logged
      })
      .finally(() => {
        pendingFilingNotifications.delete(push);
      });
    pendingFilingNotifications.add(push);
  }

  return taskRow;
}

/**
 * In-flight filing-notification promises. Short-lived CLI processes must
 * `await drainFilingNotifications()` before `db.close()`/exit: the push is
 * fire-and-forget like machine.ts's transition hook (correct for the
 * long-lived console/runner), but a CLI that closes the DB mid-flight loses
 * the notification's journal span — the push may still deliver while its
 * record vanishes, breaking the every-act-journaled law (observed live
 * 2026-09-02: the task:file CLI delivered the QUEUED push to ntfy with no
 * `ntfy_notification` span, because `finally { db.close() }` won the race).
 */
const pendingFilingNotifications = new Set<Promise<unknown>>();

/** Resolves once every filing notification fired so far has settled. */
export async function drainFilingNotifications(): Promise<void> {
  while (pendingFilingNotifications.size > 0) {
    await Promise.allSettled([...pendingFilingNotifications]);
  }
}
