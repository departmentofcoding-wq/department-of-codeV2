import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDbConnection } from '../../engine/db/index.ts';
import type { AttributionTuple, DbConnection, BureauWindowLeaseRow } from '../../engine/contract/index.ts';
import { DETERMINISTIC_ATTRIBUTION, HARNESS_META_KEYS } from '../../engine/contract/index.ts';
import { LeaseError } from '../../engine/harness/errors.ts';
import {
  acquireLease,
  startWindowLeaseHeartbeat,
  releaseLease
} from '../../engine/harness/lease-manager.ts';

describe('Unit: Lease Manager Heartbeat (Phase 8 P1.2)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-lm-hb-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDbConnection(dbPath);

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
      VALUES ('task-hb', 'HB Task', 'uuid-hb', '${now}', '${now}');

      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
      VALUES ('disp-hb-1', 'task-hb', 'uuid-hb', 'junior-engineer', 'ollama', 'qwen', '${now}'),
             ('disp-hb-2', 'task-hb', 'uuid-hb', 'junior-engineer', 'ollama', 'qwen', '${now}');
    `);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('T1: Heartbeat loop execution: Injected clock advances; heartbeatLease is called; heartbeats increment; stop() clears timer cleanly', async () => {
    const attr: AttributionTuple = { actor_role: 'junior-engineer', ...DETERMINISTIC_ATTRIBUTION };
    const lease = acquireLease(db, 'window-A', 'disp-hb-1', attr, 3000);
    expect(lease.heartbeats).toBe(0);

    let currentTime = Date.now();
    const handle = startWindowLeaseHeartbeat(db, lease.id, {
      leaseMs: 3000,
      intervalMs: 1000,
      nowMs: () => currentTime
    });

    expect(handle.intervalMs).toBe(1000);

    // Advance 1 interval
    currentTime += 1000;
    await vi.advanceTimersByTimeAsync(1000);

    let row = db.get<BureauWindowLeaseRow>('SELECT * FROM bureau_window_leases WHERE id = ?', lease.id);
    expect(row?.heartbeats).toBe(1);

    // Advance another interval
    currentTime += 1000;
    await vi.advanceTimersByTimeAsync(1000);

    row = db.get<BureauWindowLeaseRow>('SELECT * FROM bureau_window_leases WHERE id = ?', lease.id);
    expect(row?.heartbeats).toBe(2);

    const total = handle.stop();
    expect(total).toBe(2);

    // Advance further; verify no more heartbeats occur after stop
    currentTime += 2000;
    await vi.advanceTimersByTimeAsync(2000);

    row = db.get<BureauWindowLeaseRow>('SELECT * FROM bureau_window_leases WHERE id = ?', lease.id);
    expect(row?.heartbeats).toBe(2);
  });

  it('T2: Heartbeat failure handling: When lease status changes to reaped or released, the heartbeat loop catches LeaseError, invokes onError, and does not crash', async () => {
    const attr: AttributionTuple = { actor_role: 'junior-engineer', ...DETERMINISTIC_ATTRIBUTION };
    const lease = acquireLease(db, 'window-A', 'disp-hb-1', attr, 3000);

    let errorReceived: Error | null = null;
    const handle = startWindowLeaseHeartbeat(db, lease.id, {
      leaseMs: 3000,
      intervalMs: 1000,
      onError: (err) => {
        errorReceived = err;
      }
    });

    // Release the lease externally
    releaseLease(db, lease.id);

    // Advance timer to trigger next heartbeat tick
    await vi.advanceTimersByTimeAsync(1000);

    expect(errorReceived).not.toBeNull();
    expect(errorReceived).toBeInstanceOf(LeaseError);
    expect((errorReceived as any).message).toContain('released');

    // Timer should be auto-cleared on error
    const total = handle.stop();
    expect(total).toBe(0);
  });

  it('T3: Ceiling enforcement: When bureau_meta lease heartbeats ceiling is exceeded, heartbeat throws and triggers onError', async () => {
    db.run(
      `INSERT OR REPLACE INTO bureau_meta (key, value, updated_at) VALUES (?, ?, ?)`,
      HARNESS_META_KEYS.LEASE_HEARTBEATS_CEILING,
      '2',
      new Date().toISOString()
    );

    const attr: AttributionTuple = { actor_role: 'junior-engineer', ...DETERMINISTIC_ATTRIBUTION };
    const lease = acquireLease(db, 'window-A', 'disp-hb-1', attr, 3000);

    let errorReceived: Error | null = null;
    let currentTime = Date.now();
    const handle = startWindowLeaseHeartbeat(db, lease.id, {
      leaseMs: 3000,
      intervalMs: 1000,
      nowMs: () => currentTime,
      onError: (err) => {
        errorReceived = err;
      }
    });

    // 1st tick (heartbeats = 1)
    currentTime += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(errorReceived).toBeNull();

    // 2nd tick (heartbeats = 2)
    currentTime += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(errorReceived).toBeNull();

    // 3rd tick (heartbeats = 2 >= ceiling 2 -> throws)
    currentTime += 1000;
    await vi.advanceTimersByTimeAsync(1000);

    expect(errorReceived).not.toBeNull();
    expect((errorReceived as any).message).toContain('ceiling reached');
    handle.stop();
  });
});
