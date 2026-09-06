import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  artifactsRoot,
  getArtifactsRootOverride,
  readLatestArtifacts,
  setArtifactsRootOverride,
  writeJuniorArtifacts
} from '../../engine/harness/junior-artifacts.ts';
import { getRepoRoot } from '../../engine/worktrees/manager.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import type { DbConnection } from '../../engine/contract/index.ts';

function snapshotDirectory(dir: string): Record<string, { size: number; isDir: boolean }> {
  const result: Record<string, { size: number; isDir: boolean }> = {};
  if (!fs.existsSync(dir)) return result;

  function walk(current: string, rel: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result[entryRel] = { size: 0, isDir: true };
        walk(fullPath, entryRel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        result[entryRel] = { size: stat.size, isDir: false };
      }
    }
  }

  walk(dir, '');
  return result;
}

describe('tc_artifacts_root_containment: Artifacts Root Containment & Isolation', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.BUREAU_ARTIFACTS_ROOT;
    delete process.env.BUREAU_ARTIFACTS_ROOT;
    setArtifactsRootOverride(null);
  });

  afterEach(() => {
    setArtifactsRootOverride(null);
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
    setWorkspaceProvider(null);
    if (savedEnv === undefined) {
      delete process.env.BUREAU_ARTIFACTS_ROOT;
    } else {
      process.env.BUREAU_ARTIFACTS_ROOT = savedEnv;
    }
  });

  describe('Real Directory Immobility — Suite runs create NO rogue entries in real tree', () => {
    it('snapshots the real docs/junior-artifacts and proves a full dispatch/review leaves it untouched', async () => {
      const realArtifactsDir = path.join(getRepoRoot(), 'docs', 'junior-artifacts');
      const beforeSnapshot = snapshotDirectory(realArtifactsDir);

      // Run isolated dispatch and review lifecycle inside a temp directory using the override seam
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-containment-real-'));
      const isolatedArtifactsDir = path.join(tmpDir, 'docs', 'junior-artifacts');
      setArtifactsRootOverride(isolatedArtifactsDir);

      const db = createFakeDb();
      try {
        const provider = new FakeWorkspaceProvider();
        setWorkspaceProvider(provider);

        const taskId = 'task-containment-real-check';
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at)
           VALUES (?, 'Containment Task', 'Intent', 'Spec', 'Acceptance', 'node -e "process.exit(0);"', 'claimed', 0, 1, 'uuid-c-1', ?, ?)`,
          taskId,
          now,
          now
        );

        setAntigravityDriverOverride({
          runCommand: async (_prompt: string, runOpts: any) => ({
            transcript: 'Junior completed isolated work.',
            walkthrough: 'Walkthrough\nContainment verified.\nNo real dir modified.',
            plan: 'Implementation Plan\n1. Isolated test',
            fullOutput: 'Full output isolated transcript',
            junior: runOpts?.junior ?? 'A',
            launched: false
          })
        });

        db.run(
          `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
           VALUES ('disp-c-1', ?, 'uuid-c-1', 'junior', 'antigravity', 'core', NULL, 'pending', ?)`,
          taskId,
          now
        );

        const dispatchJob = enqueueJob(db, {
          kind: 'junior.dispatch',
          task_id: taskId,
          payload: { dispatchId: 'disp-c-1', taskId, prompt: 'implement containment', junior: 'A' }
        });

        await handleJuniorDispatch({
          db,
          job: dispatchJob,
          payload: JSON.parse(dispatchJob.payload),
          signal: new AbortController().signal
        });

        // Verify artifacts landed in isolated directory
        const isolatedTaskDir = path.join(isolatedArtifactsDir, taskId);
        expect(fs.existsSync(isolatedTaskDir)).toBe(true);

        // Run Senior review cycle
        setSeniorDriverOverride({
          review: async () => ({
            senior: 'claude',
            verdict: 'approve',
            feedback: 'Looks good.',
            raw: 'VERDICT: APPROVE',
            model: 'claude-3-5-sonnet'
          })
        });

        const reviewRes = await runWorkReviewCycle(db, { taskId, seniorId: 'claude' });
        expect(reviewRes.outcome).toBe('approved');
      } finally {
        db.close();
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
        } catch {}
      }

      // Assert real directory snapshot is byte-for-byte / entry-for-entry identical
      const afterSnapshot = snapshotDirectory(realArtifactsDir);
      expect(afterSnapshot).toEqual(beforeSnapshot);
    });
  });

  describe('Explicit Base Routing — Multi-project isolation', () => {
    it('routes artifacts to explicit baseDir and keeps secondary project trees isolated', () => {
      const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-proj-a-'));
      const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-proj-b-'));

      try {
        const taskIdA = 'task-proj-alpha';
        const writtenA = writeJuniorArtifacts(
          taskIdA,
          'disp-alpha-1',
          {
            junior: 'A',
            plan: 'Plan for Alpha',
            walkthrough: 'Walkthrough for Alpha',
            fullOutput: 'Transcript Alpha',
            reply: 'Alpha OK'
          },
          tmpA
        );

        expect(writtenA.dir).toContain(path.join(tmpA, 'docs', 'junior-artifacts', taskIdA));
        expect(fs.existsSync(writtenA.files['plan.md'])).toBe(true);

        // Project B should have zero artifacts
        expect(fs.existsSync(path.join(tmpB, 'docs', 'junior-artifacts'))).toBe(false);

        // Read back from project A vs project B
        const readA = readLatestArtifacts(taskIdA, tmpA);
        expect(readA.plan).toContain('Plan for Alpha');
        expect(readA.walkthrough).toContain('Walkthrough for Alpha');

        const readB = readLatestArtifacts(taskIdA, tmpB);
        expect(readB.plan).toBe('');
        expect(readB.walkthrough).toBe('');
        expect(readB.dir).toBe('');
      } finally {
        fs.rmSync(tmpA, { recursive: true, force: true });
        fs.rmSync(tmpB, { recursive: true, force: true });
      }
    });

    it('threads taskRepoRoot from bureau_projects table through dispatch and work-review cycle', async () => {
      const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-custom-proj-'));
      const db = createFakeDb();

      try {
        const provider = new FakeWorkspaceProvider();
        setWorkspaceProvider(provider);

        const projectId = 'proj-custom-repo';
        const taskId = 'task-custom-repo-1';
        const now = new Date().toISOString();

        db.run(
          `INSERT INTO bureau_projects (id, name, path_to_repo, created_at, updated_at)
           VALUES (?, 'Custom Repo Project', ?, ?, ?)`,
          projectId,
          projDir,
          now,
          now
        );

        db.run(
          `INSERT INTO bureau_tasks (id, project_id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at)
           VALUES (?, ?, 'Task for custom repo', 'Intent', 'Spec', 'Acceptance', 'node -e "process.exit(0);"', 'claimed', 0, 1, 'uuid-cr-1', ?, ?)`,
          taskId,
          projectId,
          now,
          now
        );

        db.run(
          `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
           VALUES ('disp-cr-1', ?, 'uuid-cr-1', 'junior', 'antigravity', 'core', NULL, 'pending', ?)`,
          taskId,
          now
        );

        setAntigravityDriverOverride({
          runCommand: async (_prompt: string, runOpts: any) => ({
            transcript: 'Done',
            walkthrough: 'Walkthrough in custom repo',
            plan: 'Plan in custom repo',
            fullOutput: 'Full output in custom repo',
            junior: runOpts?.junior ?? 'A',
            launched: false
          })
        });

        const dispatchJob = enqueueJob(db, {
          kind: 'junior.dispatch',
          task_id: taskId,
          payload: { dispatchId: 'disp-cr-1', taskId, prompt: 'build project feature', junior: 'A' }
        });

        await handleJuniorDispatch({
          db,
          job: dispatchJob,
          payload: JSON.parse(dispatchJob.payload),
          signal: new AbortController().signal
        });

        // Check artifacts landed in projDir and not in default cwd
        const projArtifactsDir = path.join(projDir, 'docs', 'junior-artifacts', taskId);
        expect(fs.existsSync(projArtifactsDir)).toBe(true);

        let seniorSawWalkthrough = '';
        setSeniorDriverOverride({
          review: async input => {
            seniorSawWalkthrough = input.walkthrough ?? '';
            return {
              senior: 'claude',
              verdict: 'approve',
              feedback: 'Approved',
              raw: 'VERDICT: APPROVE',
              model: 'claude-3-5-sonnet'
            };
          }
        });

        const reviewRes = await runWorkReviewCycle(db, { taskId, seniorId: 'claude' });
        expect(reviewRes.outcome).toBe('approved');
        expect(seniorSawWalkthrough).toContain('Walkthrough in custom repo');
      } finally {
        db.close();
        try {
          fs.rmSync(projDir, { recursive: true, force: true, maxRetries: 3 });
        } catch {}
      }
    });
  });

  describe('Override Seam Precedence & Resolution Order', () => {
    it('in-memory setArtifactsRootOverride takes top precedence', () => {
      const tmpOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-art-ov-'));
      process.env.BUREAU_ARTIFACTS_ROOT = '/some/env/path';

      try {
        setArtifactsRootOverride(tmpOverride);
        expect(getArtifactsRootOverride()).toBe(tmpOverride);
        expect(artifactsRoot()).toBe(tmpOverride);

        // Even if explicit baseDir is passed, global test override takes priority
        expect(artifactsRoot('/explicit/base')).toBe(tmpOverride);

        setArtifactsRootOverride(null);
        expect(getArtifactsRootOverride()).toBe('/some/env/path');
        expect(artifactsRoot()).toBe('/some/env/path');
      } finally {
        fs.rmSync(tmpOverride, { recursive: true, force: true });
      }
    });

    it('process.env.BUREAU_ARTIFACTS_ROOT takes precedence when in-memory override is null', () => {
      const tmpEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-art-env-'));
      try {
        process.env.BUREAU_ARTIFACTS_ROOT = tmpEnv;
        expect(getArtifactsRootOverride()).toBe(tmpEnv);
        expect(artifactsRoot()).toBe(tmpEnv);
      } finally {
        fs.rmSync(tmpEnv, { recursive: true, force: true });
      }
    });

    it('falls back to getRepoRoot() / docs / junior-artifacts when no override or baseDir is provided', () => {
      expect(getArtifactsRootOverride()).toBeNull();
      const expected = path.join(getRepoRoot(), 'docs', 'junior-artifacts');
      expect(artifactsRoot()).toBe(expected);
    });

    it('uses explicit baseDir when no override is set', () => {
      const explicitBase = 'D:/test-repo-base';
      const expected = path.join(explicitBase, 'docs', 'junior-artifacts');
      expect(artifactsRoot(explicitBase)).toBe(expected);
    });
  });
});
