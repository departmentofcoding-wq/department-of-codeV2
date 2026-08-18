import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbConnection } from '../../engine/db/index.ts';
import type { AttributionTuple, DbConnection } from '../../engine/contract/index.ts';
import { DETERMINISTIC_ATTRIBUTION, type BureauJournalRow } from '../../engine/contract/index.ts';
import { LeaseError } from '../../engine/harness/errors.ts';
import { acquireLease, heartbeatLease, reapExpiredWindowLeases, releaseLease } from '../../engine/harness/lease-manager.ts';

describe('T31: Window Lease Manager Integration Test (Stream A2)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t31-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDbConnection(dbPath);

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
      VALUES ('task-t31', 'T31 Task', 'uuid-t31', '${now}', '${now}');

      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
      VALUES ('disp-1', 'task-t31', 'uuid-t31', 'junior-engineer', 'ollama', 'qwen', '${now}'),
             ('disp-2', 'task-t31', 'uuid-t31', 'junior-engineer', 'ollama', 'qwen', '${now}');
    `);
  });

  afterEach(() => {
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

  it('enforces exclusivity, heartbeat extension, explicit release, and transactional reaping', () => {
    const attr: AttributionTuple = { actor_role: 'junior-engineer', ...DETERMINISTIC_ATTRIBUTION };

    // 1. Acquire active lease for window-main
    const lease1 = acquireLease(db, 'window-main', 'disp-1', attr, 60000);
    expect(lease1.status).toBe('active');
    expect(lease1.heartbeats).toBe(0);

    // 2. Second acquire for window-main MUST throw LeaseError and journal guardrail span
    expect(() => {
      acquireLease(db, 'window-main', 'disp-2', attr, 60000);
    }).toThrow(LeaseError);

    const guardrailSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%window_lease_conflict%'`
    );
    expect(guardrailSpan).toBeDefined();

    // 3. Heartbeat extends expires_at and increments heartbeats
    const hbLease = heartbeatLease(db, lease1.id);
    expect(hbLease.heartbeats).toBe(1);

    // 4. Explicit release frees window-main
    releaseLease(db, lease1.id);
    const releasedRow = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE id = ?', lease1.id);
    expect(releasedRow?.status).toBe('released');

    // Heartbeating a released lease fails
    expect(() => {
      heartbeatLease(db, lease1.id);
    }).toThrow(LeaseError);

    // 5. Acquire new lease after release succeeds
    const lease2 = acquireLease(db, 'window-main', 'disp-2', attr, 1000);
    expect(lease2.status).toBe('active');

    // 6. Expire lease2 manually and run reapExpiredWindowLeases
    const pastTime = new Date(Date.now() - 5000).toISOString();
    db.exec(`UPDATE bureau_window_leases SET expires_at = '${pastTime}' WHERE id = '${lease2.id}'`);

    const reapedCount = reapExpiredWindowLeases(db);
    expect(reapedCount).toBe(1);

    const reapedRow = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE id = ?', lease2.id);
    expect(reapedRow?.status).toBe('reaped');

    const reapedSpan = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%lease_expired_reaped%'`
    );
    expect(reapedSpan).toBeDefined();
  });
});
