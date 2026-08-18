import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbConnection } from '../../engine/db/index.ts';
import type { DbConnection } from '../../engine/contract/index.ts';
import { setIdeDriverOverride, type BureauDispatchRow, type BureauJournalRow, type IdeDriver } from '../../engine/contract/index.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { reapExpiredWindowLeases } from '../../engine/harness/lease-manager.ts';

describe('T37: Crash Safety Integration Test (Stream A3)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t37-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDbConnection(dbPath);

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
      VALUES ('task-t37', 'T37 Task', 'uuid-t37', '${now}', '${now}');

      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-t37', 'task-t37', 'uuid-t37', 'junior-engineer', 'ollama', 'qwen', 'pending', 0, '${now}');

      INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
      VALUES ('job-t37', 'junior.dispatch', 'task-t37', 'running', '${now}'),
             ('job-t37-2', 'junior.dispatch', 'task-t37', 'running', '${now}'),
             ('job-t37-fail', 'junior.dispatch', 'task-t37', 'running', '${now}');
    `);
  });

  afterEach(() => {
    setIdeDriverOverride(null);
    if (db) {
      try {
        db.close();
      } catch {
        // Ignored
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles mid-dispatch crash, reaps stale lease, re-drives safely, and releases lease on completion and failure', async () => {
    const mockDriver: IdeDriver = {
      launch: async () => {},
      navigate: async () => {},
      read: async () => ({ matchCount: 1, text: 'mock text', nonceEcho: 'n-37' }),
      act: async () => ({ success: true, nonceEcho: 'n-37' }),
      snapshot: async () => ({ outline: '<div>mock</div>' }),
      close: async () => {}
    };

    setIdeDriverOverride(mockDriver);

    const jobContext: any = {
      db,
      job: { id: 'job-t37', task_id: 'task-t37' },
      payload: { dispatchId: 'disp-t37', windowTarget: 'window-t37', actions: [] },
      signal: new AbortController().signal
    };

    // 1. Initial execution completes cleanly
    await handleJuniorDispatch(jobContext);

    const dispAfter1 = db.get<BureauDispatchRow>('SELECT * FROM bureau_dispatches WHERE id = ?', 'disp-t37');
    expect(dispAfter1?.status).toBe('completed');
    expect(dispAfter1?.attempts).toBe(1);

    // Assert that handleJuniorDispatch released its window lease upon completion
    const leaseAfter1 = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE dispatch_id = ?', 'disp-t37');
    expect(leaseAfter1?.status).toBe('released');

    const dispatchSpans = db.all<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'dispatch'`
    );
    expect(dispatchSpans.length).toBeGreaterThanOrEqual(2); // running & completed

    // 2. Simulate crash mid-dispatch on a second dispatch
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-t37-crash', 'task-t37', 'uuid-t37', 'junior-engineer', 'ollama', 'qwen', 'pending', 0, '${now}');
    `);

    // Force dispatch status to running with an active expired lease (simulating process death)
    db.exec(`
      INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
      VALUES ('lease-crashed', 'window-t37-crash', 'disp-t37-crash', 'active', '${now}', '${new Date(Date.now() - 10000).toISOString()}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
    `);

    // 3. Reap expired lease
    const reaped = reapExpiredWindowLeases(db);
    expect(reaped).toBe(1);

    const crashedLease = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE id = ?', 'lease-crashed');
    expect(crashedLease?.status).toBe('reaped');

    // 4. Re-drive dispatch after crash
    const jobContext2: any = {
      db,
      job: { id: 'job-t37-2', task_id: 'task-t37' },
      payload: { dispatchId: 'disp-t37-crash', windowTarget: 'window-t37-crash', actions: [] },
      signal: new AbortController().signal
    };

    await handleJuniorDispatch(jobContext2);

    const dispAfter2 = db.get<BureauDispatchRow>('SELECT * FROM bureau_dispatches WHERE id = ?', 'disp-t37-crash');
    expect(dispAfter2?.status).toBe('completed');
    expect(dispAfter2?.attempts).toBe(1);

    // Assert that re-driven dispatch released its new lease upon completion
    const leaseAfter2 = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE dispatch_id = ? AND status = \'released\'', 'disp-t37-crash');
    expect(leaseAfter2?.status).toBe('released');

    // 5. Test failure path: verify lease is released even when driver throws an error
    const failingDriver: IdeDriver = {
      ...mockDriver,
      navigate: async () => { throw new Error('Driver network failure'); }
    };
    setIdeDriverOverride(failingDriver);

    db.exec(`
      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-t37-fail', 'task-t37', 'uuid-t37', 'junior-engineer', 'ollama', 'qwen', 'pending', 0, '${now}');
    `);

    const failContext: any = {
      db,
      job: { id: 'job-t37-fail', task_id: 'task-t37' },
      payload: { dispatchId: 'disp-t37-fail', windowTarget: 'window-t37-fail', url: 'http://fail', actions: [] },
      signal: new AbortController().signal
    };

    await expect(handleJuniorDispatch(failContext)).rejects.toThrow('Driver network failure');

    const failedLease = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE dispatch_id = ?', 'disp-t37-fail');
    expect(failedLease?.status).toBe('released');

    // 6. Assert orphan direction: every observation row has a matching span via isCorrelated
    const { isCorrelated } = await import('../../engine/contract/index.ts');
    const observations = db.all<any>('SELECT * FROM bureau_observations');
    const spans = db.all<any>("SELECT * FROM bureau_journal WHERE kind = 'dispatch'");
    for (const obs of observations) {
      const hasSpan = spans.some((s: any) => isCorrelated(s, obs));
      expect(hasSpan).toBe(true);
    }
  });
});
