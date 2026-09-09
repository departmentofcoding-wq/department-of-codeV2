import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbConnection } from '../../engine/contract/index.ts';
import { reapOrphanedDispatches } from '../../engine/watchdog/sweep.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-r6-'));
      const db = createRealSqliteDb(path.join(tmpDir, 'test.db'));
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

function seedTask(db: DbConnection, taskId: string) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
     VALUES (?, 'R6', 'claimed', ?, ?, ?)`,
    taskId, `w-${taskId}`, now, now
  );
}

function seedDispatch(db: DbConnection, dispatchId: string, taskId: string, status: string) {
  db.run(
    `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, created_at)
     VALUES (?, ?, ?, 'junior-engineer', 'antigravity', 'unspecified', ?, ?)`,
    dispatchId, taskId, `w-${taskId}`, status, new Date().toISOString()
  );
}

function seedJob(db: DbConnection, jobId: string, taskId: string, state: string, dispatchId: string) {
  db.run(
    `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, created_at)
     VALUES (?, 'junior.dispatch', ?, ?, ?, 3, 3, 0, ?)`,
    jobId, taskId, JSON.stringify({ dispatchId }), state, new Date().toISOString()
  );
}

/**
 * R6 — orphaned dispatch rows are reaped by the watchdog sweep.
 *
 * Scar (2026-09-08): three dispatch rows sat at status='running' forever after
 * their jobs died terminally; nothing on the terminal-failure path finalizes
 * the dispatch row, so views and lease reasoning saw phantom live work.
 */
describe.each(testImplementations)('R6: watchdog reaps orphaned dispatch rows ($name)', ({ create }) => {
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

  it('a running dispatch whose job is DEAD is finalized to failed with a span', () => {
    seedTask(db, 'task-r6-dead');
    seedDispatch(db, 'disp-dead', 'task-r6-dead', 'running');
    seedJob(db, 'job-dead', 'task-r6-dead', 'dead', 'disp-dead');

    expect(reapOrphanedDispatches(db)).toBe(1);

    const row = db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-dead'`);
    expect(row?.status).toBe('failed');

    const span = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%dispatch_orphan_reaped%'`
    );
    expect(span?.detail).toContain('disp-dead');

    // Idempotent: a second sweep reaps nothing (the row is no longer running).
    expect(reapOrphanedDispatches(db)).toBe(0);
  });

  it('a running dispatch with NO job row at all is reaped', () => {
    seedTask(db, 'task-r6-nojob');
    seedDispatch(db, 'disp-nojob', 'task-r6-nojob', 'running');

    expect(reapOrphanedDispatches(db)).toBe(1);
    expect(
      db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-nojob'`)?.status
    ).toBe('failed');
  });

  it('a running dispatch whose job is PENDING or RUNNING is NOT reaped (it may still be driven)', () => {
    seedTask(db, 'task-r6-live');
    seedDispatch(db, 'disp-live-job', 'task-r6-live', 'running');
    seedJob(db, 'job-pending', 'task-r6-live', 'pending', 'disp-live-job');
    seedDispatch(db, 'disp-run-job', 'task-r6-live', 'running');
    seedJob(db, 'job-running', 'task-r6-live', 'running', 'disp-run-job');

    expect(reapOrphanedDispatches(db)).toBe(0);
    expect(
      db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-live-job'`)?.status
    ).toBe('running');
    expect(
      db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-run-job'`)?.status
    ).toBe('running');
  });

  it('pending and completed dispatch rows are never touched', () => {
    seedTask(db, 'task-r6-other');
    seedDispatch(db, 'disp-pending', 'task-r6-other', 'pending');
    seedDispatch(db, 'disp-completed', 'task-r6-other', 'completed');

    expect(reapOrphanedDispatches(db)).toBe(0);
    expect(
      db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-pending'`)?.status
    ).toBe('pending');
    expect(
      db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-completed'`)?.status
    ).toBe('completed');
  });
});
