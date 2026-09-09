import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbConnection } from '../../engine/contract/index.ts';
import { juniorIsOccupied } from '../../engine/flow/assignment.ts';
import { acquireLease, releaseLease } from '../../engine/harness/lease-manager.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-r4-'));
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

const ATTR = { actor_role: 'junior-engineer', provider: 'antigravity', model: 'test', account: null } as const;

/**
 * R4 — occupancy must see the physical window lease, not only task state.
 *
 * Scar (2026-09-08): task 9cabfabd was falsely blocked while its dispatch
 * still held the window-B lease; juniorIsOccupied('B') said FREE (no
 * claimed/verifying task), the queue admitted fec08495 onto window-B, and
 * both tasks died in lease collisions. The lease is the resource.
 */
describe.each(testImplementations)('R4: juniorIsOccupied sees active window leases ($name)', ({ create }) => {
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

  it('an ACTIVE lease on the junior window occupies the junior — even with no claimed tasks at all', () => {
    expect(juniorIsOccupied(db, 'B')).toBe(false);
    acquireLease(db, 'window-B', 'disp-live-sibling', { ...ATTR });
    expect(juniorIsOccupied(db, 'B')).toBe(true);
    // Roster isolation: a lease on B says nothing about A.
    expect(juniorIsOccupied(db, 'A')).toBe(false);
  });

  it('a RELEASED lease no longer occupies', () => {
    const lease = acquireLease(db, 'window-A', 'disp-done', { ...ATTR });
    releaseLease(db, lease.id);
    expect(juniorIsOccupied(db, 'A')).toBe(false);
  });

  it('an EXPIRED-but-active lease row does not occupy', () => {
    db.run(
      `INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, heartbeats, actor_role, provider, model, account, created_at, updated_at)
       VALUES ('lease-expired', 'window-A', 'disp-old', 'active', ?, ?, 0, 'junior-engineer', 'antigravity', 'test', NULL, ?, ?)`,
      new Date(Date.now() - 120_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 120_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString()
    );
    expect(juniorIsOccupied(db, 'A')).toBe(false);
  });

  it('still occupies via task state when no lease exists (the original law unchanged)', () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, assigned_junior, assigned_senior, assigned_at, created_at, updated_at)
       VALUES ('task-r4', 'R4', 'claimed', 1, 'w-r4', 'A', 'zai', ?, ?, ?)`,
      now, now, now
    );
    expect(juniorIsOccupied(db, 'A')).toBe(true);
  });
});
