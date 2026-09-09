import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { reconcileQueuedTasks } from '../../engine/flow/reconcile.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import type { DbConnection } from '../../engine/contract/index.ts';

/**
 * The R-pack concurrency regression — the invariant the 2026-09-08 incident
 * broke (N17's "one task per junior"): two tasks run concurrently, one per
 * junior, with a third queued behind them. Nothing may die on a cross-lease
 * conflict, and the queue may not double-book a junior whose window lease is
 * actively held (R4) — the exact door through which fec08495 was admitted onto
 * window-B while 9cabfabd's dispatch still held it.
 */
describe('R-pack regression: two concurrent tasks, one per junior, third queued', () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createFakeDb();
    const now = new Date().toISOString();
    // Two admitted tasks, each pinned to its own junior, mid-implementation.
    for (const [id, junior] of [['task-reg-A', 'A'], ['task-reg-B', 'B']] as const) {
      db.run(
        `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, assigned_junior, assigned_senior, assigned_at, created_at, updated_at)
         VALUES (?, 'Regression task', 'claimed', 1, ?, ?, 'zai', ?, ?, ?)`,
        id, `w-${id}`, junior, now, now, now
      );
      db.run(
        `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, created_at)
         VALUES (?, ?, ?, 'junior-engineer', 'antigravity', 'unspecified', 'pending', ?)`,
        `disp-${id}`, id, `w-${id}`, now
      );
    }
    // The third task: queued, unassigned, waiting for capacity.
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, created_at, updated_at)
       VALUES ('task-reg-C', 'Queued task', 'queued', 1, 'w-task-reg-C', ?, ?)`,
      now, now
    );
  });

  afterEach(() => {
    setAntigravityDriverOverride(null);
  });

  function dispatchCtx(taskId: string) {
    const job = enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: taskId,
      payload: { dispatchId: `disp-${taskId}`, stage: 'junior-implementation', prompt: `implement ${taskId}`, junior: taskId.endsWith('A') ? 'A' : 'B' },
      max_attempts: 1
    });
    return { db, job, payload: JSON.parse(job.payload), signal: undefined } as any;
  }

  it('both juniors dispatch concurrently with no cross-lease death; the queued task is NOT double-booked onto a leased window', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    setAntigravityDriverOverride({
      async runCommand() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 250));
        inFlight--;
        return { transcript: `agent: done`, launched: false };
      }
    } as any);

    // Reconcile while BOTH windows are still held: no junior is free (R4 sees
    // the active leases), so the queued task must NOT be admitted.
    const runA = handleJuniorDispatch(dispatchCtx('task-reg-A'));
    const runB = handleJuniorDispatch(dispatchCtx('task-reg-B'));
    await new Promise((r) => setTimeout(r, 120)); // both leases now active

    const admitted = await reconcileQueuedTasks(db, { probe: async () => true });
    expect(admitted).toEqual([]);
    const cTask = db.get<{ state: string; assigned_junior: string | null }>(
      `SELECT state, assigned_junior FROM bureau_tasks WHERE id = 'task-reg-C'`
    );
    expect(cTask?.state).toBe('queued');
    expect(cTask?.assigned_junior).toBeNull();
    expect(
      db.get(`SELECT 1 FROM bureau_jobs WHERE task_id = 'task-reg-C' AND kind = 'plan.cycle'`)
    ).toBeFalsy();

    // Both dispatches complete cleanly — each on its OWN window, no conflicts.
    await Promise.all([runA, runB]);
    expect(maxInFlight).toBe(2);
    for (const id of ['task-reg-A', 'task-reg-B']) {
      expect(
        db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = ?`, `disp-${id}`)?.status
      ).toBe('completed');
    }
    expect(
      db.all(`SELECT * FROM bureau_window_leases WHERE status = 'active'`)
    ).toHaveLength(0);

    // A/B leave their juniors only at needs-review (the N17 law — a claimed
    // task occupies its junior). Simulate that handoff, then the queue admits
    // the third task (no deadlock from R4's lease-aware occupancy).
    db.run(`UPDATE bureau_tasks SET state = 'needs-review' WHERE id IN ('task-reg-A', 'task-reg-B')`);
    const admittedAfter = await reconcileQueuedTasks(db, { probe: async () => true });
    expect(admittedAfter).toEqual(['task-reg-C']);
    expect(
      db.get<{ assigned_junior: string }>(`SELECT assigned_junior FROM bureau_tasks WHERE id = 'task-reg-C'`)?.assigned_junior
    ).toBeTruthy();
  });
});
