import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbConnection } from '../../engine/contract/index.ts';
import { reconcileQueuedTasks } from '../../engine/flow/reconcile.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
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

  it('enqueues exactly one plan.cycle for a queued task that has none', () => {
    insertTask(db, 'task-stranded', 'queued');

    const enqueued = reconcileQueuedTasks(db);
    expect(enqueued).toEqual(['task-stranded']);

    const jobs = db.all<{ id: string; task_id: string; state: string }>(
      `SELECT id, task_id, state FROM bureau_jobs WHERE kind = 'plan.cycle'`
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('plan.cycle:task-stranded');
    expect(jobs[0].task_id).toBe('task-stranded');
    expect(jobs[0].state).toBe('pending');
  });

  it('is idempotent: a second sweep enqueues nothing and leaves exactly one job', () => {
    insertTask(db, 'task-stranded', 'queued');

    expect(reconcileQueuedTasks(db)).toEqual(['task-stranded']);
    expect(reconcileQueuedTasks(db)).toEqual([]);

    const jobs = db.all(`SELECT id FROM bureau_jobs WHERE kind = 'plan.cycle'`);
    expect(jobs).toHaveLength(1);
  });

  it('is bounded: does not re-enqueue for a task whose earlier cycle already failed/dead', () => {
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

    expect(reconcileQueuedTasks(db)).toEqual([]);

    const jobs = db.all<{ state: string }>(`SELECT state FROM bureau_jobs WHERE kind = 'plan.cycle'`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('dead');
  });

  it('ignores tasks that are not queued', () => {
    insertTask(db, 'task-claimed', 'claimed');
    insertTask(db, 'task-blocked', 'blocked');

    expect(reconcileQueuedTasks(db)).toEqual([]);
    expect(db.all(`SELECT id FROM bureau_jobs WHERE kind = 'plan.cycle'`)).toHaveLength(0);
  });
});
