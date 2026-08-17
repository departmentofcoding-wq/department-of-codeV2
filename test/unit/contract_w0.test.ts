import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { applyBootMigrations } from '../../engine/db/schema.ts';
import {
  scrubEnv,
  redactOutput,
  parseVerifyOutcome,
  setWorkspaceProvider,
  getWorkspaceProvider,
  type WorkspaceProvider,
  type WorkspaceHandle,
  type AttributionTuple,
  type BureauTaskRow
} from '../../engine/contract/index.ts';
import { canTransition, transition, rearmTask } from '../../engine/state/index.ts';


describe('Milestone W0 — Contract Freeze Unit Tests', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-w0-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const humanAttr: AttributionTuple = {
    actor_role: 'human-operator',
    provider: 'human',
    model: 'operator',
    account: 'admin'
  };

  const verifierAttr: AttributionTuple = {
    actor_role: 'verifier',
    provider: 'deterministic',
    model: 'core',
    account: null
  };

  const juniorAttr: AttributionTuple = {
    actor_role: 'junior-engineer',
    provider: 'antigravity',
    model: 'gemini-3.6-flash',
    account: null
  };

  function seedTask(db: any, taskId = 't-w0-1', initialState = 'verifying'): BureauTaskRow {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO bureau_tasks (
        id, title, state, verifier_exit_code, work_uuid, verify_fixes, created_at, updated_at
      ) VALUES (?, 'W0 Test Task', ?, null, 'work-w0', 1, ?, ?)
      RETURNING *
    `);
    return stmt.get(taskId, initialState, now, now) as BureauTaskRow;
  }

  describe('1. Transition Rules & Role Gates', () => {
    it('verifying -> claimed (send-back) is allowed for verifier role and rejected for junior-engineer', () => {
      expect(canTransition('verifying', 'claimed', 'verifier')).toBe(true);
      expect(canTransition('verifying', 'claimed', 'junior-engineer')).toBe(false);
    });

    it('verifying -> blocked (ceiling reached) is allowed for verifier role and rejected for junior-engineer', () => {
      expect(canTransition('verifying', 'blocked', 'verifier')).toBe(true);
      expect(canTransition('verifying', 'blocked', 'junior-engineer')).toBe(false);
    });

    it('blocked -> claimed is rejected by canTransition for non-human-operator', () => {
      expect(canTransition('blocked', 'claimed', 'human-operator')).toBe(true);
      expect(canTransition('blocked', 'claimed', 'verifier')).toBe(false);
      expect(canTransition('blocked', 'claimed', 'junior-engineer')).toBe(false);
    });

    it('needs-review -> done is rejected for non-human-operator', () => {
      expect(canTransition('needs-review', 'done', 'human-operator')).toBe(true);
      expect(canTransition('needs-review', 'done', 'senior-engineer')).toBe(false);
    });
  });

  describe('2. rearmTask Single-Writer', () => {
    it('rearmTask resets verify_fixes to 0, transitions blocked -> claimed, enqueues verify.run job, and writes human journal span', () => {
      const db = openDbConnection(dbPath);
      seedTask(db, 't-blocked', 'blocked');

      // Set verify_fixes to 2 to simulate ceiling reach
      db.prepare("UPDATE bureau_tasks SET verify_fixes = 2 WHERE id = 't-blocked'").run();

      const rearmed = rearmTask(db, 't-blocked', humanAttr);
      expect(rearmed.state).toBe('claimed');
      expect(rearmed.verify_fixes).toBe(0);

      // Verify verify.run job enqueued
      const jobs = db.prepare("SELECT * FROM bureau_jobs WHERE task_id = 't-blocked' AND kind = 'verify.run'").all() as any[];
      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe('pending');

      // Verify human journal span written
      const journal = db.prepare("SELECT * FROM bureau_journal WHERE task_id = 't-blocked' AND kind = 'human'").all() as any[];
      expect(journal).toHaveLength(1);
      expect(JSON.parse(journal[0].detail)).toEqual({ action: 'rearm', rearmedBy: 'human-operator:admin' });
    });

    it('rearmTask throws when called by non-human-operator role', () => {
      const db = openDbConnection(dbPath);
      seedTask(db, 't-blocked-2', 'blocked');

      expect(() => rearmTask(db, 't-blocked-2', verifierAttr)).toThrow(/Task re-arm requires human-operator role/);
      expect(() => rearmTask(db, 't-blocked-2', juniorAttr)).toThrow(/Task re-arm requires human-operator role/);
    });

    it('rearmTask throws when task is not in blocked state', () => {
      const db = openDbConnection(dbPath);
      seedTask(db, 't-claimed', 'claimed');

      expect(() => rearmTask(db, 't-claimed', humanAttr)).toThrow(/must be blocked/);
    });
  });

  describe('3. Database Migration Test (Phase 1 -> Phase 2 blocked state)', () => {
    it('applyBootMigrations rebuilds Phase 1 bureau_tasks table with foreign keys OFF, updates CHECK constraint, and accepts blocked state', () => {
      // Boot a raw Phase 1 database with the old bureau_tasks CHECK constraint (without 'blocked')
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec('PRAGMA foreign_keys = ON;');
      rawDb.exec(`
        CREATE TABLE bureau_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          intent TEXT, spec TEXT, acceptance TEXT,
          verify_cmd TEXT, setup_cmd TEXT,
          state TEXT NOT NULL DEFAULT 'intake'
            CHECK (state IN ('intake','queued','claimed','verifying','needs-review','done','failed')),
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

        CREATE TABLE bureau_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor_role TEXT NOT NULL, provider TEXT NOT NULL,
          model TEXT NOT NULL, account TEXT,
          task_id TEXT REFERENCES bureau_tasks(id),
          work_uuid TEXT, work_title TEXT,
          job_id TEXT,
          tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, latency_ms INTEGER,
          detail TEXT NOT NULL DEFAULT '{}'
        );
      `);

      const now = new Date().toISOString();
      rawDb.prepare(`
        INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
        VALUES ('t-old', 'Old Phase 1 Task', 'claimed', 'w-1', ?, ?)
      `).run(now, now);

      rawDb.prepare(`
        INSERT INTO bureau_journal (ts, kind, actor_role, provider, model, task_id, detail)
        VALUES (?, 'transition', 'verifier', 'deterministic', 'core', 't-old', '{}')
      `).run(now);

      // Verify that writing 'blocked' before migration fails the old CHECK constraint
      expect(() => {
        rawDb.prepare("UPDATE bureau_tasks SET state = 'blocked' WHERE id = 't-old'").run();
      }).toThrow(/CHECK constraint failed/);

      // Run boot migrations (which rebuilds bureau_tasks safely with foreign keys disabled)
      applyBootMigrations(rawDb);

      // Now updating to state 'blocked' succeeds!
      rawDb.prepare("UPDATE bureau_tasks SET state = 'blocked' WHERE id = 't-old'").run();
      const updated = rawDb.prepare("SELECT state FROM bureau_tasks WHERE id = 't-old'").get() as { state: string };
      expect(updated.state).toBe('blocked');

      // Verify index and intake_session_id column exist
      const tableInfo = rawDb.prepare("PRAGMA table_info(bureau_tasks)").all() as any[];
      expect(tableInfo.some(c => c.name === 'intake_session_id')).toBe(true);

      const idxList = rawDb.prepare("PRAGMA index_list(bureau_tasks)").all() as any[];
      expect(idxList.some(i => i.name === 'idx_tasks_intake_session')).toBe(true);

      rawDb.close();
    });
  });

  describe('4. Contract Pure Functions (scrubEnv, redactOutput, parseVerifyOutcome)', () => {
    it('scrubEnv strips secret keys and preserves standard environment variables', () => {
      const parentEnv: Record<string, string | undefined> = {
        PATH: '/usr/bin:/bin',
        SYSTEMROOT: 'C:\\Windows',
        GOOGLE_API_KEY: 'secret-google-key',
        ANTHROPIC_KEY: 'secret-anthropic-key',
        OPENAI_SECRET: 'secret-openai-key',
        BUREAU_SECRET_TOKEN: 'secret-bureau-token',
        MY_CUSTOM_API_KEY: 'custom-key',
        USER: 'dev'
      };

      const clean = scrubEnv(parentEnv);
      expect(clean.PATH).toBe('/usr/bin:/bin');
      expect(clean.SYSTEMROOT).toBe('C:\\Windows');
      expect(clean.USER).toBe('dev');

      expect(clean.GOOGLE_API_KEY).toBeUndefined();
      expect(clean.ANTHROPIC_KEY).toBeUndefined();
      expect(clean.OPENAI_SECRET).toBeUndefined();
      expect(clean.BUREAU_SECRET_TOKEN).toBeUndefined();
      expect(clean.MY_CUSTOM_API_KEY).toBeUndefined();
    });

    it('redactOutput masks API keys and environment secrets with [REDACTED]', () => {
      process.env.TEST_BUREAU_API_KEY = 'super-secret-12345';
      try {
        const text = 'Error using key super-secret-12345 and AIzaSy123456789012345678901234567890123';
        const redacted = redactOutput(text);
        expect(redacted).not.toContain('super-secret-12345');
        expect(redacted).not.toContain('AIzaSy123456789012345678901234567890123');
        expect(redacted).toContain('[REDACTED]');
      } finally {
        delete process.env.TEST_BUREAU_API_KEY;
      }
    });

    it('parseVerifyOutcome evaluates exitCode, signal, and timedOut accurately', () => {
      expect(parseVerifyOutcome(0, null, false)).toEqual({
        success: true,
        timedOut: false,
        signal: null,
        exitCode: 0
      });

      expect(parseVerifyOutcome(1, null, false)).toEqual({
        success: false,
        timedOut: false,
        signal: null,
        exitCode: 1
      });

      expect(parseVerifyOutcome(null, 'SIGKILL', true)).toEqual({
        success: false,
        timedOut: true,
        signal: 'SIGKILL',
        exitCode: null
      });
    });
  });

  describe('5. Neutral Workspace Seam (workspace-seam.ts)', () => {
    it('getWorkspaceProvider throws error when uninitialized and retrieves provider when set', async () => {
      expect(() => getWorkspaceProvider()).toThrow(/Workspace provider has not been initialized/);

      const fakeProvider: WorkspaceProvider = {
        async prepare(_db, taskId) {
          return { taskId, path: '/tmp/worktree', baseCommit: 'abc' };
        },
        async getWorkspaceHandle(_db, taskId) {
          return { taskId, path: '/tmp/worktree', baseCommit: 'abc' };
        },
        async checkpoint(_db, _taskId, _attribution, _note) {},
        async isClean(_db, _taskId) {
          return true;
        }
      };

      setWorkspaceProvider(fakeProvider);
      const provider = getWorkspaceProvider();
      expect(provider).toBe(fakeProvider);

      const db = openDbConnection(dbPath);
      const handle = await provider.getWorkspaceHandle(db, 'task-seam-1');
      expect(handle).toEqual({ taskId: 'task-seam-1', path: '/tmp/worktree', baseCommit: 'abc' });
    });
  });
});
