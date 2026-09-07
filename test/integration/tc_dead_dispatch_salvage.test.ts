import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDbConnection } from '../../engine/db/index.ts';
import type { BureauDispatchRow, BureauJobRow, BureauJournalRow, BureauTaskRow, DbConnection } from '../../engine/contract/index.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { setJuniorProviderOverride } from '../../engine/contract/junior-seam.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';
import { Runner } from '../../runner/main.ts';
import { subscribeTaskStateChange, clearTaskStateSubscribers, type TaskStateChangeEvent } from '../../engine/state/notifications.ts';

describe('C1: Dead-dispatch work reconciliation — the salvage detector', () => {
  let tmpDir: string;
  let db: DbConnection & { close: () => void };
  let repoRoot: string;
  let notifications: TaskStateChangeEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-c1-test-'));
    repoRoot = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });

    db = openDbConnection(path.join(tmpDir, 'test.db'));
    notifications = [];
    clearTaskStateSubscribers();
    unsubscribe = subscribeTaskStateChange((event) => {
      notifications.push(event);
    });
  });

  afterEach(() => {
    unsubscribe();
    clearTaskStateSubscribers();
    setAntigravityDriverOverride(null);
    setWorkspaceProvider(null);
    setJuniorProviderOverride(null);
    try { db.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupTask(taskId: string, opts?: { assignedJunior?: string }) {
    const now = new Date(Date.now() - 5000).toISOString();
    const junior = opts?.assignedJunior ?? 'A';
    const escapedRepo = repoRoot.replace(/\\/g, '/');
    db.exec(`
      INSERT INTO bureau_projects (id, name, path_to_repo, created_at, updated_at)
      VALUES ('proj-${taskId}', 'Proj ${taskId}', '${escapedRepo}', '${now}', '${now}');
      INSERT INTO bureau_tasks (id, title, project_id, state, work_uuid, created_at, updated_at, assigned_junior, assigned_senior, assigned_at)
      VALUES ('${taskId}', 'Task ${taskId}', 'proj-${taskId}', 'claimed', 'work-${taskId}', '${now}', '${now}', '${junior}', 'claude', '${now}');
      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-${taskId}', '${taskId}', 'work-${taskId}', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 2, '${now}');
      INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, created_at)
      VALUES ('job-${taskId}', 'junior.dispatch', '${taskId}', '{"dispatchId":"disp-${taskId}","prompt":"do work","junior":"${junior}"}', 'pending', 2, 3, '${now}');
    `);
  }

  it('detects work in dirty worktree when dispatch dies terminally -> transitions task to blocked, captures artifacts, journals span, fires notification', async () => {
    const taskId = 'task-dirty';
    setupTask(taskId);

    const wsProvider = new FakeWorkspaceProvider(path.join(tmpDir, 'worktrees'));
    setWorkspaceProvider(wsProvider);
    const wsHandle = await wsProvider.prepare(db, taskId);

    // Junior dirtied the worktree
    fs.writeFileSync(path.join(wsHandle.path, 'output.ts'), 'export const answer = 42;');

    // Junior driver throws an unrecoverable/terminal error (attempt 3/3)
    setAntigravityDriverOverride({
      async runCommand() {
        throw new Error('CDP connection reset: process unreachable');
      }
    });

    const runner = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000 });
    runner.start();

    // Wait for the single job to execute and fail terminally
    let done = false;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', `job-${taskId}`);
      if (job?.state === 'dead') {
        done = true;
        break;
      }
    }
    await runner.stop();

    expect(done).toBe(true);

    // 1. Task transitioned to 'blocked'
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('blocked');

    // 2. Guardrail span recorded
    const spans = db.all<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'`,
      taskId
    );
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const salvageSpan = spans.find(s => {
      const d = JSON.parse(s.detail as string);
      return d.action === 'dead_dispatch_work_detected';
    });
    expect(salvageSpan).toBeDefined();
    const spanDetail = JSON.parse(salvageSpan!.detail as string);
    expect(spanDetail.worktreeDirty).toBe(true);

    // 3. Artifacts written to docs/junior-artifacts/<taskId>/...
    const artifactsDir = path.join(repoRoot, 'docs', 'junior-artifacts', taskId);
    expect(fs.existsSync(artifactsDir)).toBe(true);
    const taskArtifacts = db.get<any>(
      `SELECT * FROM bureau_journal WHERE task_id = ? AND detail LIKE '%artifactsWritten%'`,
      taskId
    );
    expect(taskArtifacts).toBeDefined();

    // 4. Notification fired for blocked state
    const blockedNotification = notifications.find(n => n.taskId === taskId && n.state === 'blocked');
    expect(blockedNotification).toBeDefined();
  });

  it('clean death (no work in worktree or brain) leaves task claimed and does not transition to blocked', async () => {
    const taskId = 'task-clean';
    setupTask(taskId);

    const wsProvider = new FakeWorkspaceProvider(path.join(tmpDir, 'worktrees'));
    setWorkspaceProvider(wsProvider);
    // Prepare clean worktree with no files
    await wsProvider.prepare(db, taskId);

    // Provider has no brain dir
    setJuniorProviderOverride({
      brainDir: () => null
    });

    setAntigravityDriverOverride({
      async runCommand() {
        throw new Error('Connection refused on port 9333');
      }
    });

    const runner = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000 });
    runner.start();

    let done = false;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', `job-${taskId}`);
      if (job?.state === 'dead') {
        done = true;
        break;
      }
    }
    await runner.stop();

    expect(done).toBe(true);

    // Task stays claimed (today's clean failure behavior, no salvage needed)
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('claimed');

    // No dead_dispatch_work_detected guardrail span
    const spans = db.all<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail' AND detail LIKE '%dead_dispatch_work_detected%'`,
      taskId
    );
    expect(spans.length).toBe(0);
  });

  it('provider with no brain seam still blocks on the worktree-dirty signal alone', async () => {
    const taskId = 'task-no-brain-seam';
    setupTask(taskId);

    const wsProvider = new FakeWorkspaceProvider(path.join(tmpDir, 'worktrees'));
    setWorkspaceProvider(wsProvider);
    const wsHandle = await wsProvider.prepare(db, taskId);

    // Junior dirtied the worktree
    fs.writeFileSync(path.join(wsHandle.path, 'patch.diff'), '--- a\n+++ b');

    // Provider returns null for brainDir
    setJuniorProviderOverride({
      brainDir: () => null
    });

    setAntigravityDriverOverride({
      async runCommand() {
        throw new Error('Agent crashed before returning response');
      }
    });

    const runner = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000 });
    runner.start();

    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', `job-${taskId}`);
      if (job?.state === 'dead') break;
    }
    await runner.stop();

    // Successfully transitioned to blocked on worktree signal alone
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('blocked');

    const span = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail' AND detail LIKE '%dead_dispatch_work_detected%'`,
      taskId
    );
    expect(span).toBeDefined();
  });

  it('detects brain work when worktree is clean and captures brain transcript + plan + walkthrough', async () => {
    const taskId = 'task-brain-only';
    setupTask(taskId);

    const wsProvider = new FakeWorkspaceProvider(path.join(tmpDir, 'worktrees'));
    setWorkspaceProvider(wsProvider);
    await wsProvider.prepare(db, taskId);

    // Mock brain directory with conversation artifacts
    const brainDir = path.join(tmpDir, 'mock-brain');
    const convDir = path.join(brainDir, 'conv-1234');
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, 'implementation_plan.md'), '# Plan\nDo things');
    fs.writeFileSync(path.join(convDir, 'walkthrough.md'), '# Walkthrough\nDid things');
    fs.writeFileSync(path.join(convDir, 'reply.md'), 'All tests passed');

    setJuniorProviderOverride({
      brainDir: () => brainDir
    });

    setAntigravityDriverOverride({
      async runCommand() {
        throw new Error('CDP lost connection during completion check');
      }
    });

    const runner = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000 });
    runner.start();

    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', `job-${taskId}`);
      if (job?.state === 'dead') break;
    }
    await runner.stop();

    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('blocked');

    const span = db.get<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail' AND detail LIKE '%dead_dispatch_work_detected%'`,
      taskId
    );
    expect(span).toBeDefined();
    const detail = JSON.parse(span!.detail as string);
    expect(detail.brainWorkDetected).toBe(true);
  });
});
