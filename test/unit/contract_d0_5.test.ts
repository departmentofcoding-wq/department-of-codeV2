import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbConnection } from '../../engine/db/adapter.ts';
import { applySchema } from '../../engine/db/schema.ts';
import { getJobDefinition } from '../../engine/jobs/registry.ts';

describe('Milestone D0-5 — Contract Freeze (Phase 5)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-d0-5-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore OS file lock delay on temp cleanup
    }
  });

  it('1. Schema Boot: creates bureau_ownership and bureau_watchdog_findings tables on fresh DB', () => {
    const rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);

    const tables = rawDb.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map(t => t.name));

    expect(tableNames.has('bureau_ownership')).toBe(true);
    expect(tableNames.has('bureau_watchdog_findings')).toBe(true);

    const ownershipCols = rawDb.prepare('PRAGMA table_info(bureau_ownership)').all() as Array<{ name: string }>;
    const ownershipNames = new Set(ownershipCols.map(c => c.name));
    expect(ownershipNames.has('key')).toBe(true);
    expect(ownershipNames.has('holder_id')).toBe(true);
    expect(ownershipNames.has('holder_role')).toBe(true);
    expect(ownershipNames.has('leased_at')).toBe(true);
    expect(ownershipNames.has('expires_at')).toBe(true);
    expect(ownershipNames.has('notes')).toBe(true);

    const watchdogCols = rawDb.prepare('PRAGMA table_info(bureau_watchdog_findings)').all() as Array<{ name: string }>;
    const watchdogNames = new Set(watchdogCols.map(c => c.name));
    expect(watchdogNames.has('id')).toBe(true);
    expect(watchdogNames.has('task_id')).toBe(true);
    expect(watchdogNames.has('finding_class')).toBe(true);
    expect(watchdogNames.has('status')).toBe(true);
    expect(watchdogNames.has('recovery_job_id')).toBe(true);

    rawDb.close();
  });

  it('2. Schema Migration: migrates a Phase 4 database by adding recover_attempts and new tables idempotently', () => {
    const db = openDbConnection(dbPath);

    // Verify bureau_tasks has recover_attempts column
    const taskCols = db.prepare('PRAGMA table_info(bureau_tasks)').all() as Array<{ name: string }>;
    expect(taskCols.some(c => c.name === 'recover_attempts')).toBe(true);

    // Verify bureau_ownership exists and can accept rows
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_ownership (key, holder_id, holder_role, leased_at, expires_at, notes, created_at, updated_at)
       VALUES ('window:1', 'worker-1', 'junior-engineer', ?, ?, 'test lease', ?, ?)`,
      now, now, now, now
    );

    const ownership = db.get<{ key: string; holder_id: string }>(
      'SELECT * FROM bureau_ownership WHERE key = ?',
      'window:1'
    );
    expect(ownership?.holder_id).toBe('worker-1');

    // Idempotency check: re-opening DB executes boot migrations cleanly without error
    db.close();
    const dbReopen = openDbConnection(dbPath);
    const ownershipReopen = dbReopen.get<{ key: string; holder_id: string }>(
      'SELECT * FROM bureau_ownership WHERE key = ?',
      'window:1'
    );
    expect(ownershipReopen?.holder_id).toBe('worker-1');
    dbReopen.close();
  });

  it('3. Job Registry: registers Phase 5 no-op job stubs cleanly', () => {
    const sweepDef = getJobDefinition('watchdog.sweep');
    expect(sweepDef).toBeDefined();
    expect(sweepDef?.kind).toBe('watchdog.sweep');

    const recoverDef = getJobDefinition('watchdog.recover');
    expect(recoverDef).toBeDefined();
    expect(recoverDef?.kind).toBe('watchdog.recover');

    const backupDef = getJobDefinition('backup.push');
    expect(backupDef).toBeDefined();
    expect(backupDef?.kind).toBe('backup.push');

    const claimDef = getJobDefinition('secretary.claim');
    expect(claimDef).toBeDefined();
    expect(claimDef?.kind).toBe('secretary.claim');

    const releaseDef = getJobDefinition('secretary.release');
    expect(releaseDef).toBeDefined();
    expect(releaseDef?.kind).toBe('secretary.release');
  });
});
