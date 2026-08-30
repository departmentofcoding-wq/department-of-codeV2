import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbConnection } from '../../engine/db/index.ts';
import type { AttributionTuple, BureauDispatchRow, BureauJournalRow, BureauWindowLeaseRow, DbConnection } from '../../engine/contract/index.ts';
import { DETERMINISTIC_ATTRIBUTION, HARNESS_META_KEYS } from '../../engine/contract/index.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { setAntigravityDriverOverride, type AntigravityDriver } from '../../engine/harness/antigravity-seam.ts';
import {
  acquireLease,
  reapExpiredWindowLeases,
  startWindowLeaseHeartbeat
} from '../../engine/harness/lease-manager.ts';
import { LeaseError } from '../../engine/harness/errors.ts';

describe('Integration: Window Lease Heartbeat & Per-Junior Scoping (Phase 8 P1.2)', () => {
  let tmpDir: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-disp-hb-'));
    db = openDbConnection(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
      VALUES ('task-1', 'Task 1', 'uuid-1', '${now}', '${now}'),
             ('task-2', 'Task 2', 'uuid-2', '${now}', '${now}');

      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-1', 'task-1', 'uuid-1', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 0, '${now}'),
             ('disp-2', 'task-2', 'uuid-2', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 0, '${now}'),
             ('disp-3', 'task-1', 'uuid-1', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 0, '${now}');

      INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
      VALUES ('job-1', 'junior.dispatch', 'task-1', 'running', '${now}'),
             ('job-2', 'junior.dispatch', 'task-2', 'running', '${now}'),
             ('job-3', 'junior.dispatch', 'task-1', 'running', '${now}');
    `);
  });

  afterEach(() => {
    vi.useRealTimers();
    setAntigravityDriverOverride(null);
    try { db.close(); } catch { /* ignore */ }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('T4: Long dispatch renewal: lease is heartbeated during long run and not reaped', async () => {
    db.run(
      `INSERT OR REPLACE INTO bureau_meta (key, value, updated_at) VALUES (?, ?, ?)`,
      HARNESS_META_KEYS.LEASE_MS,
      '3000',
      new Date().toISOString()
    );

    let runFinished = false;
    const fakeDriver: AntigravityDriver = {
      async runCommand() {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        runFinished = true;
        return { transcript: 'agent: long run completed', launched: false };
      }
    };
    setAntigravityDriverOverride(fakeDriver);

    const ctx: any = {
      db,
      job: { id: 'job-1', task_id: 'task-1' },
      payload: { dispatchId: 'disp-1', prompt: 'long running command', junior: 'A' },
      signal: new AbortController().signal
    };

    const dispatchPromise = handleJuniorDispatch(ctx);

    // Initial check: active lease exists
    let leaseRow = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE dispatch_id = 'disp-1'`
    );
    expect(leaseRow).toBeDefined();
    expect(leaseRow?.window_target).toBe('window-A');
    expect(leaseRow?.status).toBe('active');

    // Advance 4000ms (beyond the initial 3000ms lease duration)
    await vi.advanceTimersByTimeAsync(4000);

    // Lease should have heartbeated and NOT expired
    leaseRow = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE dispatch_id = 'disp-1'`
    );
    expect(leaseRow?.status).toBe('active');
    expect(leaseRow?.heartbeats).toBeGreaterThanOrEqual(2);

    // Attempt reaping at T=4000ms
    const reapedCount = reapExpiredWindowLeases(db, Date.now());
    expect(reapedCount).toBe(0);

    // Advance remaining 1000ms to complete the dispatch
    await vi.advanceTimersByTimeAsync(1000);
    await dispatchPromise;

    expect(runFinished).toBe(true);

    const completedDisp = db.get<BureauDispatchRow>(
      `SELECT * FROM bureau_dispatches WHERE id = 'disp-1'`
    );
    expect(completedDisp?.status).toBe('completed');

    // Lease was released on completion
    leaseRow = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE dispatch_id = 'disp-1'`
    );
    expect(leaseRow?.status).toBe('released');

    // Check heartbeat journal spans
    const startedSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%window_lease_heartbeat_started%'`
    );
    expect(startedSpan).toBeDefined();

    const stoppedSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%window_lease_heartbeat_stopped%'`
    );
    expect(stoppedSpan).toBeDefined();
    const stoppedDetail = JSON.parse(stoppedSpan?.detail as string);
    expect(stoppedDetail.heartbeats).toBeGreaterThanOrEqual(2);
  });

  it('T5: Per-junior concurrency & exclusivity: distinct juniors run concurrently without conflict; same junior conflicts', async () => {
    db.run(
      `INSERT OR REPLACE INTO bureau_meta (key, value, updated_at) VALUES (?, ?, ?)`,
      HARNESS_META_KEYS.LEASE_MS,
      '3000',
      new Date().toISOString()
    );

    const fakeDriver: AntigravityDriver = {
      async runCommand() {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { transcript: 'agent: done', launched: false };
      }
    };
    setAntigravityDriverOverride(fakeDriver);

    const ctxA: any = {
      db,
      job: { id: 'job-1', task_id: 'task-1' },
      payload: { dispatchId: 'disp-1', prompt: 'task A', junior: 'A' },
      signal: new AbortController().signal
    };

    const ctxB: any = {
      db,
      job: { id: 'job-2', task_id: 'task-2' },
      payload: { dispatchId: 'disp-2', prompt: 'task B', junior: 'B' },
      signal: new AbortController().signal
    };

    // Both dispatches start concurrently
    const promiseA = handleJuniorDispatch(ctxA);
    const promiseB = handleJuniorDispatch(ctxB);

    const leaseA = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE dispatch_id = 'disp-1'`
    );
    const leaseB = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE dispatch_id = 'disp-2'`
    );

    expect(leaseA?.window_target).toBe('window-A');
    expect(leaseA?.status).toBe('active');
    expect(leaseB?.window_target).toBe('window-B');
    expect(leaseB?.status).toBe('active');

    // A third dispatch attempting junior 'A' concurrently fails with LeaseError
    const ctxA2: any = {
      db,
      job: { id: 'job-3', task_id: 'task-1' },
      payload: { dispatchId: 'disp-3', prompt: 'task A concurrent', junior: 'A' },
      signal: new AbortController().signal
    };

    await expect(handleJuniorDispatch(ctxA2)).rejects.toThrow(LeaseError);

    // Advance 4000ms (beyond 3000ms initial lease duration). Active heartbeat on A still holds window-A
    await vi.advanceTimersByTimeAsync(4000);

    await expect(handleJuniorDispatch(ctxA2)).rejects.toThrow(LeaseError);

    // Advance remaining 1000ms to complete both
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([promiseA, promiseB]);

    expect(
      db.get<BureauDispatchRow>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-1'`)?.status
    ).toBe('completed');
    expect(
      db.get<BureauDispatchRow>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-2'`)?.status
    ).toBe('completed');
  });

  it('T6: Fail-closed hard process crash simulation: abandoned lease expires and is reaped', async () => {
    const attr: AttributionTuple = { actor_role: 'junior-engineer', ...DETERMINISTIC_ATTRIBUTION };
    const lease = acquireLease(db, 'window-A', 'disp-1', attr, 3000);

    // Simulate crash: start heartbeat loop and abandon it (clear fake timers or stop the process)
    const handle = startWindowLeaseHeartbeat(db, lease.id, {
      leaseMs: 3000,
      intervalMs: 1000
    });

    // Abandon: abruptly stop heartbeat loop without calling releaseLease
    handle.stop();

    // Advance time past expiry
    await vi.advanceTimersByTimeAsync(4000);

    // reapExpiredWindowLeases reaps the abandoned lease
    const reaped = reapExpiredWindowLeases(db, Date.now());
    expect(reaped).toBe(1);

    const leaseRow = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE id = ?`,
      lease.id
    );
    expect(leaseRow?.status).toBe('reaped');

    const reapedSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%lease_expired_reaped%'`
    );
    expect(reapedSpan).toBeDefined();

    // Subsequent dispatch for window-A can now acquire lease successfully
    const lease2 = acquireLease(db, 'window-A', 'disp-2', attr, 3000);
    expect(lease2.status).toBe('active');
  });

  it('T7: Fail-closed lease loss during dispatch: manual reap triggers error callback and aborts dispatch', async () => {
    db.run(
      `INSERT OR REPLACE INTO bureau_meta (key, value, updated_at) VALUES (?, ?, ?)`,
      HARNESS_META_KEYS.LEASE_MS,
      '3000',
      new Date().toISOString()
    );

    const fakeDriver: AntigravityDriver = {
      async runCommand(_prompt, opts) {
        return new Promise((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new Error('Driver aborted by signal'));
          });
        });
      }
    };
    setAntigravityDriverOverride(fakeDriver);

    const ctx: any = {
      db,
      job: { id: 'job-1', task_id: 'task-1' },
      payload: { dispatchId: 'disp-1', prompt: 'test abort', junior: 'A' },
      signal: new AbortController().signal
    };

    const dispatchPromise = handleJuniorDispatch(ctx);

    // Manually mark lease as reaped in the DB behind dispatch's back
    db.run(
      `UPDATE bureau_window_leases SET status = 'reaped' WHERE dispatch_id = 'disp-1'`
    );

    // Advance timer to trigger next heartbeat tick (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    // The dispatch should reject due to abort
    await expect(dispatchPromise).rejects.toThrow();

    // Dispatch status should be failed in journal
    const failedSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%window_lease_heartbeat_failed%'`
    );
    expect(failedSpan).toBeDefined();

    const dispatchFailedSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'dispatch' AND detail LIKE '%"status":"failed"%'`
    );
    expect(dispatchFailedSpan).toBeDefined();
  });
});
