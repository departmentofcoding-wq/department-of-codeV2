import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauOwnershipRow, DbConnection } from '../../engine/contract/types.ts';
import { openDbConnection } from '../../engine/db/adapter.ts';
import { claimOwnership, releaseOwnership } from '../../engine/secretary/ownership.ts';

describe('T47 — Secretary Authoritative Ownership (secretary.claim / secretary.release)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t47-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDbConnection(dbPath);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('1. Acquires fresh claim with notes and lease duration', () => {
    const key = 'branch:wt/junior-a-hardening';
    const holderId = 'worker-1';
    const holderRole = 'junior-engineer';
    const notes = 'working on milestone A3';

    const row = claimOwnership(db, { key, holderId, holderRole, leaseMs: 60000, notes });
    expect(row.key).toBe(key);
    expect(row.holder_id).toBe(holderId);
    expect(row.holder_role).toBe(holderRole);
    expect(row.notes).toBe(notes);

    const dbRow = db.get<BureauOwnershipRow>(`SELECT * FROM bureau_ownership WHERE key = ?`, key);
    expect(dbRow).toBeDefined();
    expect(dbRow?.holder_id).toBe(holderId);
  });

  it('2. Double-Claim Refusal (Fail-Closed): second claim on held unexpired key is refused', () => {
    const key = 'window:win-1';
    claimOwnership(db, { key, holderId: 'worker-1', holderRole: 'junior-engineer', leaseMs: 60000 });

    expect(() => {
      claimOwnership(db, { key, holderId: 'worker-2', holderRole: 'junior-engineer', leaseMs: 60000 });
    }).toThrow(/refused: currently held/);

    const dbRow = db.get<BureauOwnershipRow>(`SELECT * FROM bureau_ownership WHERE key = ?`, key);
    expect(dbRow?.holder_id).toBe('worker-1');
  });

  it('3. Expired Lease Reclamation: claim on expired key is reclaimed by new holder', () => {
    const key = 'branch:wt/expired';
    const pastLeaseTime = new Date(Date.now() - 60000).toISOString();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_ownership (key, holder_id, holder_role, leased_at, expires_at, notes, created_at, updated_at)
       VALUES (?, 'old-worker', 'junior-engineer', ?, ?, 'old lease', ?, ?)`,
      key,
      pastLeaseTime,
      pastLeaseTime,
      pastLeaseTime,
      pastLeaseTime
    );

    const reclaimed = claimOwnership(db, { key, holderId: 'new-worker', holderRole: 'junior-engineer', leaseMs: 60000, notes: 'reclaimed' });
    expect(reclaimed.holder_id).toBe('new-worker');
    expect(reclaimed.notes).toBe('reclaimed');
  });

  it('4. Release Ownership: valid holder releases key', () => {
    const key = 'branch:wt/to-release';
    claimOwnership(db, { key, holderId: 'worker-1', holderRole: 'junior-engineer' });

    const released = releaseOwnership(db, { key, holderId: 'worker-1' });
    expect(released).toBe(true);

    const dbRow = db.get<BureauOwnershipRow>(`SELECT * FROM bureau_ownership WHERE key = ?`, key);
    expect(dbRow).toBeUndefined();
  });

  it('5. Wrong-Holder Release Refusal: release by non-holder is refused', () => {
    const key = 'branch:wt/protected';
    claimOwnership(db, { key, holderId: 'worker-1', holderRole: 'junior-engineer' });

    expect(() => {
      releaseOwnership(db, { key, holderId: 'worker-imposter' });
    }).toThrow(/refused: attempted by 'worker-imposter' but held by 'worker-1'/);

    const dbRow = db.get<BureauOwnershipRow>(`SELECT * FROM bureau_ownership WHERE key = ?`, key);
    expect(dbRow?.holder_id).toBe('worker-1');
  });
});
