import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbConnection } from '../../engine/contract/index.ts';
import { reconcileQueuedTasks } from '../../engine/flow/reconcile.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { clearJuniorUnhealthy } from '../../engine/flow/junior-health.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-reconcile-'));
      const dbPath = path.join(tmpDir, 'test.db');
      const db = createRealSqliteDb(dbPath);
      return {
        db,
        cleanup: () => {
          db.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      };
    }
  }
];

/** Insert a task row directly, bypassing the filing door, in a chosen state. */
function insertTask(db: DbConnection, id: string, state: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, work_title,
       plan_rounds, verify_fixes, cycles, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0, 0, ?, ?)`,
    id,
    `Task ${id}`,
    state,
    `work-${id}`,
    `Task ${id}`,
    now,
    now
  );
}

describe.each(testImplementations)('Reconciler reconcileQueuedTasks ($name)', ({ create }) => {
  let db: DbConnection;
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('enqueues exactly one plan.cycle for a queued task that has none', async () => {
    insertTask(db, 'task-stranded', 'queued');

    const enqueued = await reconcileQueuedTasks(db, { probe: async () => true });
    expect(enqueued).toEqual(['task-stranded']);

    const jobs = db.all<{ id: string; task_id: string; state: string }>(
      `SELECT id, task_id, state FROM bureau_jobs WHERE kind = 'plan.cycle'`
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('plan.cycle:task-stranded');
    expect(jobs[0].task_id).toBe('task-stranded');
    expect(jobs[0].state).toBe('pending');
  });

  it('is idempotent: a second sweep enqueues nothing and leaves exactly one job', async () => {
    insertTask(db, 'task-stranded', 'queued');

    expect(await reconcileQueuedTasks(db, { probe: async () => true })).toEqual(['task-stranded']);
    expect(await reconcileQueuedTasks(db, { probe: async () => true })).toEqual([]);

    const jobs = db.all(`SELECT id FROM bureau_jobs WHERE kind = 'plan.cycle'`);
    expect(jobs).toHaveLength(1);
  });

  it('is bounded: does not re-enqueue for a task whose earlier cycle already failed/dead', async () => {
    insertTask(db, 'task-failed-cycle', 'queued');
    // Simulate a cycle that already ran and terminally failed.
    const job = enqueueJob(db, {
      id: 'plan.cycle:task-failed-cycle',
      kind: 'plan.cycle',
      task_id: 'task-failed-cycle',
      payload: { taskId: 'task-failed-cycle' },
      max_attempts: 1
    });
    db.run(`UPDATE bureau_jobs SET state = 'dead' WHERE id = ?`, job.id);

    expect(await reconcileQueuedTasks(db, { probe: async () => true })).toEqual([]);

    const jobs = db.all<{ state: string }>(`SELECT state FROM bureau_jobs WHERE kind = 'plan.cycle'`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('dead');
  });

  it('ignores tasks that are not queued', async () => {
    insertTask(db, 'task-claimed', 'claimed');
    insertTask(db, 'task-blocked', 'blocked');

    expect(await reconcileQueuedTasks(db, { probe: async () => true })).toEqual([]);
    expect(db.all(`SELECT id FROM bureau_jobs WHERE kind = 'plan.cycle'`)).toHaveLength(0);
  });

  // --- Junior auto-warmup hook + quiet rule (docs/plan-junior-auto-warmup.md) ---

  function spanActions(db: DbConnection, taskId: string, action: string): number {
    return db.all(
      `SELECT id FROM bureau_journal
       WHERE task_id = ? AND json_extract(detail, '$.action') = ?`,
      taskId,
      action
    ).length;
  }

  it('probe failure requests a background warm for every probed junior (default no-op hook stays loud)', async () => {
    insertTask(db, 'task-warm-hook', 'queued');
    const requestWarmup = vi.fn((_junior: string) => false);
    const admitted = await reconcileQueuedTasks(db, { probe: async () => false, requestWarmup });
    expect(admitted).toEqual([]);
    // Both roster juniors were probed and each failure requested a warm.
    expect(requestWarmup.mock.calls.map(c => c[0]).sort()).toEqual(['A', 'B']);
    // Hook returned false (no warm in flight) -> the loud C3 path is intact.
    expect(spanActions(db, 'task-warm-hook', 'queue_probe_roster_exhausted')).toBe(1);
    expect(spanActions(db, 'task-warm-hook', 'queue_probe_warming')).toBe(0);
  });

  it('quiet rule (R2): with every probe-failed junior warming, the sweep journals queue_probe_warming and does NOT page (no roster-exhausted span)', async () => {
    insertTask(db, 'task-warming', 'queued');
    const requestWarmup = vi.fn(() => true);

    const admitted = await reconcileQueuedTasks(db, { probe: async () => false, requestWarmup });
    expect(admitted).toEqual([]);
    expect(spanActions(db, 'task-warming', 'queue_probe_warming')).toBe(1);
    expect(spanActions(db, 'task-warming', 'queue_probe_roster_exhausted')).toBe(0);
    // The per-junior hold span is still recorded (cooldown marking is unchanged).
    expect(spanActions(db, 'task-warming', 'junior_unhealthy_hold')).toBe(2);
  });

  it('quiet rule is per-junior: one warming + one non-warming failed junior still pages (mixed roster stays loud)', async () => {
    insertTask(db, 'task-mixed', 'queued');
    const requestWarmup = vi.fn((j: string) => j === 'A');

    const admitted = await reconcileQueuedTasks(db, { probe: async () => false, requestWarmup });
    expect(admitted).toEqual([]);
    const exhausted = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal
       WHERE task_id = 'task-mixed' AND json_extract(detail, '$.action') = 'queue_probe_roster_exhausted'`
    );
    expect(exhausted).toBeTruthy();
    expect(JSON.parse(exhausted!.detail).warming).toEqual(['A']);
    expect(spanActions(db, 'task-mixed', 'queue_probe_warming')).toBe(0);
  });

  it('the un-wedge path: a cold junior is held + warmed on sweep 1, then admitted on sweep 2 once the warm cleared cooldown and the probe passes', async () => {
    insertTask(db, 'task-cold', 'queued');
    // Occupy junior B so the candidate roster is exactly [A].
    insertTask(db, 'occupant-b', 'claimed');
    db.run(`UPDATE bureau_tasks SET assigned_junior = 'B' WHERE id = 'occupant-b'`);

    let juniorAUp = false;
    const requestWarmup = (j: string): boolean => {
      if (j !== 'A') return false;
      // The "warm" completes: the junior comes up and its admission cooldown clears.
      juniorAUp = true;
      clearJuniorUnhealthy(db, 'A');
      return true;
    };
    const probe = async (cfg: { id: string }) => cfg.id === 'A' && juniorAUp;

    // Sweep 1: A is cold — held (cooldown + span), warm requested, quiet warming span.
    expect(await reconcileQueuedTasks(db, { probe, requestWarmup })).toEqual([]);
    expect(spanActions(db, 'task-cold', 'junior_unhealthy_hold')).toBe(1);
    expect(spanActions(db, 'task-cold', 'queue_probe_warming')).toBe(1);

    // Sweep 2: the warm finished — A passes the probe and the task is admitted.
    expect(await reconcileQueuedTasks(db, { probe, requestWarmup })).toEqual(['task-cold']);
    const task = db.get<{ assigned_junior: string | null }>(
      'SELECT assigned_junior FROM bureau_tasks WHERE id = ?',
      'task-cold'
    );
    expect(task?.assigned_junior).toBe('A');
  });
});
