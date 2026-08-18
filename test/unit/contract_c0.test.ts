import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_MS,
  HARNESS_META_KEYS,
  JOB_KINDS,
  SPAN_KINDS,
  getIdeDriver,
  getIdeDriverOverride,
  isCorrelated,
  leaseIsExpired,
  mintNonce,
  setIdeDriverOverride,
  type IdeDriver
} from '../../engine/contract/index.ts';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';

describe('Milestone C0 Contract & Schema Freeze', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-c0-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new DatabaseSync(dbPath);
    setIdeDriverOverride(null);
  });

  afterEach(() => {
    setIdeDriverOverride(null);
    if (db) {
      try {
        db.close();
      } catch {
        // Ignored if already closed
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Contract Constants & Types Freeze', () => {
    it('freezes Phase 3 job kinds, span kinds, and harness meta keys', () => {
      expect(JOB_KINDS).toContain('junior.dispatch');
      expect(JOB_KINDS).toContain('selector.calibrate');
      expect(JOB_KINDS).toContain('lease.reap');

      expect(SPAN_KINDS).toContain('dispatch');
      expect(SPAN_KINDS).toContain('observation');

      expect(HARNESS_META_KEYS.LEASE_MS).toBe('harness:lease_ms');
      expect(HARNESS_META_KEYS.LEASE_HEARTBEATS_CEILING).toBe('harness:lease:heartbeats');
      expect(DEFAULT_LEASE_MS).toBe(120_000);
    });
  });

  describe('IDE Driver Seam Overrides', () => {
    it('throws if getIdeDriver is called before driver is registered', () => {
      expect(() => getIdeDriver()).toThrow('IDE driver has not been initialized or registered.');
      expect(getIdeDriverOverride()).toBeNull();
    });

    it('sets and retrieves registered IDE driver override', () => {
      const mockDriver: IdeDriver = {
        launch: async () => {},
        navigate: async () => {},
        read: async () => ({ matchCount: 1, text: 'hello', nonceEcho: 'n-1' }),
        act: async () => ({ success: true, nonceEcho: 'n-1' }),
        snapshot: async () => ({ outline: '<div></div>' }),
        close: async () => {}
      };

      setIdeDriverOverride(mockDriver);
      expect(getIdeDriver()).toBe(mockDriver);
      expect(getIdeDriverOverride()).toBe(mockDriver);

      setIdeDriverOverride(null);
      expect(() => getIdeDriver()).toThrow('IDE driver has not been initialized or registered.');
      expect(getIdeDriverOverride()).toBeNull();
    });
  });

  describe('Harness Pure Functions', () => {
    it('mintNonce generates 32-char lowercase hex strings that vary across calls', () => {
      const n1 = mintNonce();
      const n2 = mintNonce();
      expect(n1).toMatch(/^[0-9a-f]{32}$/);
      expect(n2).toMatch(/^[0-9a-f]{32}$/);
      expect(n1).not.toBe(n2);
    });

    it('isCorrelated pins strict JSON parsing and exact nonce equality (C0-A2)', () => {
      const nonceVal = mintNonce();
      const obs = { nonce: nonceVal };

      // Exact match
      expect(isCorrelated({ detail: JSON.stringify({ nonce: nonceVal, extra: 'foo' }) }, obs)).toBe(true);

      // Near-miss nonce (1 char different)
      const nearMissNonce = nonceVal.slice(0, -1) + (nonceVal.endsWith('a') ? 'b' : 'a');
      expect(isCorrelated({ detail: JSON.stringify({ nonce: nearMissNonce }) }, obs)).toBe(false);

      // Nonce embedded as substring inside detail text (forbidden prefix/substring matching)
      expect(isCorrelated({ detail: JSON.stringify({ message: `contains ${nonceVal} in string` }) }, obs)).toBe(false);

      // Malformed JSON
      expect(isCorrelated({ detail: '{ invalid json' }, obs)).toBe(false);

      // Missing nonce field
      expect(isCorrelated({ detail: JSON.stringify({ other: 'value' }) }, obs)).toBe(false);

      // Null or invalid inputs
      expect(isCorrelated({ detail: '' }, obs)).toBe(false);
    });

    it('leaseIsExpired tests exact boundary instant and supports string ISO / epoch / Date', () => {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const pastIso = new Date(now - 1000).toISOString();
      const futureIso = new Date(now + 1000).toISOString();

      // Past lease is expired
      expect(leaseIsExpired({ expires_at: pastIso }, now)).toBe(true);
      expect(leaseIsExpired({ expires_at: pastIso }, nowIso)).toBe(true);

      // Exact boundary instant (nowMs === expires_at) is expired
      expect(leaseIsExpired({ expires_at: nowIso }, now)).toBe(true);
      expect(leaseIsExpired({ expires_at: nowIso }, new Date(now))).toBe(true);

      // Future lease is not expired
      expect(leaseIsExpired({ expires_at: futureIso }, now)).toBe(false);
      expect(leaseIsExpired({ expires_at: futureIso }, nowIso)).toBe(false);
    });
  });

  describe('Database Schema & Boot Migrations (C0-A3)', () => {
    it('migrates a Phase 2 database by adding dispatches.attempts, new tables, and partial index', () => {
      // Boot a Phase 2 style database (without attempts on dispatches, without Phase 3 tables)
      db.exec(`
        CREATE TABLE bureau_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          intent TEXT, spec TEXT, acceptance TEXT,
          verify_cmd TEXT, setup_cmd TEXT,
          state TEXT NOT NULL DEFAULT 'intake',
          verifier_exit_code INTEGER,
          approved_at TEXT, approved_by TEXT,
          merged_at TEXT, merged_by TEXT,
          priority INTEGER NOT NULL DEFAULT 1,
          work_uuid TEXT NOT NULL,
          work_title TEXT,
          plan_rounds INTEGER NOT NULL DEFAULT 0,
          verify_fixes INTEGER NOT NULL DEFAULT 0,
          cycles INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          pull_request_url TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );

        CREATE TABLE bureau_dispatches (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
          work_uuid TEXT NOT NULL,
          job_id TEXT,
          ide_model TEXT,
          ide_account TEXT,
          actor_role TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          account TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          finished_at TEXT
        );
      `);

      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
        VALUES ('task-p2', 'Phase 2 Task', 'uuid-p2', '${now}', '${now}');

        INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
        VALUES ('disp-p2', 'task-p2', 'uuid-p2', 'junior-engineer', 'ollama', 'qwen2.5-coder', '${now}');
      `);

      // Verify attempts column absent
      const preCols = db.prepare('PRAGMA table_info(bureau_dispatches)').all() as Array<{ name: string }>;
      expect(preCols.some(c => c.name === 'attempts')).toBe(false);

      // Run schema boot door
      applySchema(db);
      applyBootMigrations(db);

      // Assert attempts column exists and preserved pre-existing row with default 0
      const postCols = db.prepare('PRAGMA table_info(bureau_dispatches)').all() as Array<{ name: string }>;
      expect(postCols.some(c => c.name === 'attempts')).toBe(true);

      const dispRow = db.prepare('SELECT attempts FROM bureau_dispatches WHERE id = ?').get('disp-p2') as { attempts: number };
      expect(dispRow.attempts).toBe(0);

      // Assert new tables exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map(t => t.name));
      expect(tableNames.has('bureau_selectors')).toBe(true);
      expect(tableNames.has('bureau_window_leases')).toBe(true);
      expect(tableNames.has('bureau_observations')).toBe(true);
    });

    it('enforces window lease partial UNIQUE index exclusivity (C0-A3)', () => {
      applySchema(db);
      applyBootMigrations(db);

      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 60000).toISOString();

      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
        VALUES ('task-1', 'Task 1', 'uuid-1', '${now}', '${now}');

        INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
        VALUES ('disp-1', 'task-1', 'uuid-1', 'junior-engineer', 'ollama', 'qwen', '${now}'),
               ('disp-2', 'task-1', 'uuid-1', 'junior-engineer', 'ollama', 'qwen', '${now}');
      `);

      // First active lease on window-1 succeeds
      db.exec(`
        INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
        VALUES ('lease-1', 'window-1', 'disp-1', 'active', '${now}', '${expires}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
      `);

      // Second active lease on window-1 MUST fail due to idx_window_leases_active
      expect(() => {
        db.exec(`
          INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
          VALUES ('lease-2', 'window-1', 'disp-2', 'active', '${now}', '${expires}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
        `);
      }).toThrow();

      // Released or expired leases on window-1 alongside an active lease are allowed
      db.exec(`
        INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
        VALUES ('lease-3', 'window-1', 'disp-2', 'released', '${now}', '${expires}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
      `);

      // Active lease on a different window-2 succeeds
      db.exec(`
        INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
        VALUES ('lease-4', 'window-2', 'disp-2', 'active', '${now}', '${expires}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
      `);
    });

    it('enforces bureau_observations.nonce UNIQUE constraint (C0-A1)', () => {
      applySchema(db);
      applyBootMigrations(db);

      const now = new Date().toISOString();
      const testNonce = mintNonce();

      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
        VALUES ('task-obs', 'Obs Task', 'uuid-obs', '${now}', '${now}');

        INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
        VALUES ('disp-obs', 'task-obs', 'uuid-obs', 'junior-engineer', 'ollama', 'qwen', '${now}');
      `);

      // First observation with testNonce succeeds
      db.exec(`
        INSERT INTO bureau_observations (id, dispatch_id, nonce, selector_key, observed, actor_role, provider, model, created_at)
        VALUES ('obs-1', 'disp-obs', '${testNonce}', 'sel.btn', '{}', 'junior-engineer', 'ollama', 'qwen', '${now}');
      `);

      // Duplicate observation with same testNonce MUST be refused by DB
      expect(() => {
        db.exec(`
          INSERT INTO bureau_observations (id, dispatch_id, nonce, selector_key, observed, actor_role, provider, model, created_at)
          VALUES ('obs-2', 'disp-obs', '${testNonce}', 'sel.btn', '{}', 'junior-engineer', 'ollama', 'qwen', '${now}');
        `);
      }).toThrow();
    });

    it('enforces status CHECK constraints on selectors and window leases (C0-A3)', () => {
      applySchema(db);
      applyBootMigrations(db);

      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 60000).toISOString();

      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
        VALUES ('task-chk', 'Chk Task', 'uuid-chk', '${now}', '${now}');

        INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
        VALUES ('disp-chk', 'task-chk', 'uuid-chk', 'junior-engineer', 'ollama', 'qwen', '${now}');
      `);

      // Invalid status on bureau_selectors throws CHECK constraint
      expect(() => {
        db.exec(`
          INSERT INTO bureau_selectors (id, key, css, status, actor_role, provider, model, created_at, updated_at)
          VALUES ('sel-invalid', 'btn.submit', '.submit', 'invalid_status', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
        `);
      }).toThrow();

      // Invalid status on bureau_window_leases throws CHECK constraint
      expect(() => {
        db.exec(`
          INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
          VALUES ('lease-invalid', 'window-x', 'disp-chk', 'unknown_status', '${now}', '${expires}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
        `);
      }).toThrow();
    });
  });
});
