import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAN_ROUNDS_CEILING,
  DEFAULT_PR_BASE_BRANCH,
  JOB_KINDS,
  REVIEW_PR_META_KEYS,
  SPAN_KINDS,
  getPrProvider,
  getPrProviderOverride,
  getWorkspaceProvider,
  getWorkspaceProviderOverride,
  setPrProviderOverride,
  setWorkspaceProvider,
  type BureauWorkReviewRow,
  type PrProvider,
  type WorkspaceProvider
} from '../../engine/contract/index.ts';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';
import { journal } from '../../engine/journal/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';

describe('Milestone D0 — Contract Freeze', () => {
  let testDb: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    testDb = createFakeDb();
    setWorkspaceProvider(null);
    setPrProviderOverride(null);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    setPrProviderOverride(null);
    testDb?.close();
  });

  describe('1. Schema Migration (bureau_work_reviews.reviewed_commit)', () => {
    it('migrates a Phase 3 database by adding reviewed_commit column and preserving legacy rows', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-d0-migration-'));
      const dbPath = path.join(tmpDir, 'legacy.db');
      const db = new DatabaseSync(dbPath);

      // Create legacy bureau_tasks & bureau_work_reviews (Phase 3 schema without reviewed_commit)
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

        CREATE TABLE bureau_work_reviews (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
          work_uuid TEXT NOT NULL,
          phase TEXT NOT NULL,
          round INTEGER NOT NULL DEFAULT 0,
          verdict TEXT NOT NULL,
          comments TEXT,
          actor_role TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          account TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // Insert a legacy work review row
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
        VALUES ('task-1', 'Legacy Task', 'w-1', '${now}', '${now}');

        INSERT INTO bureau_work_reviews (
          id, task_id, work_uuid, phase, round, verdict, comments, actor_role, provider, model, created_at
        ) VALUES (
          'rev-1', 'task-1', 'w-1', 'work', 1, 'approved', 'looks good', 'senior-engineer', 'deterministic', 'core', '${now}'
        );
      `);

      // Verify reviewed_commit column does NOT exist
      const initialCols = db.prepare('PRAGMA table_info(bureau_work_reviews)').all() as Array<{ name: string }>;
      expect(initialCols.some((c) => c.name === 'reviewed_commit')).toBe(false);

      // Run boot door
      applySchema(db);
      applyBootMigrations(db);

      // Assert reviewed_commit column now exists
      const migratedCols = db.prepare('PRAGMA table_info(bureau_work_reviews)').all() as Array<{ name: string }>;
      expect(migratedCols.some((c) => c.name === 'reviewed_commit')).toBe(true);

      // Assert legacy row survived with reviewed_commit IS NULL
      const row = db.prepare('SELECT * FROM bureau_work_reviews WHERE id = ?').get('rev-1') as unknown as BureauWorkReviewRow;
      expect(row).toBeDefined();
      expect(row.id).toBe('rev-1');
      expect(row.verdict).toBe('approved');
      expect(row.reviewed_commit).toBeNull();

      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('2. PR Provider Seam & Override Semantics', () => {
    it('throws when getPrProvider is called before registration, and returns set instance when set', () => {
      expect(getPrProviderOverride()).toBeNull();
      expect(() => getPrProvider()).toThrow('PR provider has not been initialized or registered.');

      const fakePrProvider: PrProvider = {
        pushBranch: async () => {},
        createPr: async (input) => ({ url: `https://github.com/org/repo/pull/42`, number: 42 }),
        mergePr: async () => {}
      };

      setPrProviderOverride(fakePrProvider);
      expect(getPrProviderOverride()).toBe(fakePrProvider);
      expect(getPrProvider()).toBe(fakePrProvider);

      setPrProviderOverride(null);
      expect(getPrProviderOverride()).toBeNull();
      expect(() => getPrProvider()).toThrow('PR provider has not been initialized or registered.');
    });

    it('validates WorkspaceProvider seam override triple', () => {
      expect(getWorkspaceProviderOverride()).toBeNull();
      expect(() => getWorkspaceProvider()).toThrow('Workspace provider has not been initialized or registered.');

      const fakeWs = new FakeWorkspaceProvider();
      setWorkspaceProvider(fakeWs);
      expect(getWorkspaceProviderOverride()).toBe(fakeWs);
      expect(getWorkspaceProvider()).toBe(fakeWs);

      fakeWs.cleanup();
    });
  });

  describe('3. Workspace Provider prune() Semantics', () => {
    it('implements prune() on FakeWorkspaceProvider with strict prune.ts guards', async () => {
      const db = testDb;
      const fakeWs = new FakeWorkspaceProvider();
      setWorkspaceProvider(fakeWs);

      // 1. Missing task/worktree -> no-op
      await expect(fakeWs.prune(db, 'nonexistent-task')).resolves.toBeUndefined();

      // Prepare a task and worktree
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        'task-ws', 'Task WS', 'work-1', now, now
      );
      const handle = await fakeWs.prepare(db, 'task-ws');

      db.run(
        `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'wt-1', 'task-ws', handle.path, 'base-sha', 'dirty', now, now, 'foreman', 'deterministic', 'core'
      );

      // 2. Refuses to prune if status is not 'ready'
      await expect(fakeWs.prune(db, 'task-ws')).rejects.toThrow(
        "Refusing to prune worktree for task task-ws: status is 'dirty' (must be 'ready')"
      );

      // Update status to 'ready'
      db.run(`UPDATE bureau_worktrees SET status = 'ready' WHERE id = 'wt-1'`);

      // 3. Prunes ready worktree -> marks status 'removed', removes path
      await fakeWs.prune(db, 'task-ws');

      const wtRow = db.get<{ status: string }>(`SELECT status FROM bureau_worktrees WHERE id = 'wt-1'`);
      expect(wtRow?.status).toBe('removed');

      // 4. Repeated prune on 'removed' status is no-op
      await expect(fakeWs.prune(db, 'task-ws')).resolves.toBeUndefined();

      fakeWs.cleanup();
    });

    it('has prune() present on GitWorkspaceProvider', () => {
      const gitWs = new GitWorkspaceProvider();
      expect(typeof gitWs.prune).toBe('function');
    });
  });

  describe('4. Journal Door Validation for "review" Span Kind', () => {
    it('accepts kind "review" in journal door and persists entry', () => {
      const db = testDb;
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        'task-rev', 'Task Review', 'work-rev', now, now
      );

      const entry = journal(db, {
        kind: 'review',
        attribution: {
          actor_role: 'senior-engineer',
          provider: 'deterministic',
          model: 'core',
          account: null
        },
        taskId: 'task-rev',
        detail: { phase: 'plan', verdict: 'approved' }
      });

      expect(entry).toBeDefined();
      expect(entry.kind).toBe('review');
      expect(entry.actor_role).toBe('senior-engineer');

      const queried = db.get<{ kind: string; detail: string }>(
        `SELECT kind, detail FROM bureau_journal WHERE id = ?`,
        entry.id
      );
      expect(queried?.kind).toBe('review');
      expect(JSON.parse(queried!.detail)).toEqual({ phase: 'plan', verdict: 'approved' });
    });
  });

  describe('5. Contract Constants & Types', () => {
    it('registers new job kinds in JOB_KINDS', () => {
      expect(JOB_KINDS).toContain('senior.review-plan');
      expect(JOB_KINDS).toContain('senior.review-work');
      expect(JOB_KINDS).toContain('pr.create');
      expect(JOB_KINDS).toContain('pr.merge');
    });

    it('registers review span kind in SPAN_KINDS', () => {
      expect(SPAN_KINDS).toContain('review');
    });

    it('exports REVIEW_PR_META_KEYS and default ceiling/branch constants', () => {
      expect(REVIEW_PR_META_KEYS.REVIEW_PLAN_ROUNDS_CEILING).toBe('review:plan_rounds_ceiling');
      expect(REVIEW_PR_META_KEYS.PR_BASE_BRANCH).toBe('pr:base_branch');
      expect(DEFAULT_PLAN_ROUNDS_CEILING).toBe(3);
      expect(DEFAULT_PR_BASE_BRANCH).toBe('main');
    });
  });
});
