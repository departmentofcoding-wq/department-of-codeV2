import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { handlePrCreate } from '../../engine/delivery/pr_create.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { setPrProviderOverride } from '../../engine/contract/pr-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

describe('T43: pr.create Job Integration Test', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let fakePrProvider: FakePrProvider;
  let gitWorkspaceProvider: GitWorkspaceProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t43-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    // Init temp git repo as main
    fs.mkdirSync(repoPath, { recursive: true });
    execSync('git init', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });
    execSync('git config user.email "test@example.com"', { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Temp Repo');
    execSync('git add README.md', { cwd: repoPath });
    execSync('git commit -m "initial commit"', { cwd: repoPath });
    execSync('git branch -M main', { cwd: repoPath });

    fakePrProvider = new FakePrProvider();
    setPrProviderOverride(fakePrProvider);

    gitWorkspaceProvider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(gitWorkspaceProvider);
  });

  afterEach(() => {
    setPrProviderOverride(null);
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function seedTaskWithWorktree(db: any, taskId: string) {
    const handle = await gitWorkspaceProvider.prepare(db, taskId);
    const tipHash = execSync('git rev-parse HEAD', { cwd: handle.path, encoding: 'utf8' }).trim();
    return { handle, tipHash };
  }

  function seedTaskRow(db: any, taskId: string, opts?: { approved?: boolean; exitCode?: number; state?: string }) {
    const now = new Date().toISOString();
    const approvedAt = opts?.approved ? now : null;
    const approvedBy = opts?.approved ? 'human-operator:admin' : null;
    const state = opts?.state || 'needs-review';
    const exitCode = opts?.exitCode !== undefined ? opts.exitCode : 0;

    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, approved_at, approved_by, work_uuid, created_at, updated_at)
       VALUES (?, 'T43 Task', 'Test intent', ?, ?, ?, ?, 'work-uuid', ?, ?)`,
      taskId,
      state,
      exitCode,
      approvedAt,
      approvedBy,
      now,
      now
    );
  }

  function seedWorkReview(db: any, taskId: string, verdict: string, commitHash: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
       VALUES (?, ?, 'work-uuid', 'work', 1, ?, ?, 'senior-engineer', 'zai', 'glm-5.2', ?)`,
      `wr-${Math.random()}`,
      taskId,
      verdict,
      commitHash,
      now
    );
  }

  it('happy path: pushes branch, creates PR, updates pull_request_url, journals system span, enqueues pr.merge', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-43-happy';

    seedTaskRow(db, taskId, { approved: true, exitCode: 0 });
    const { tipHash } = await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', tipHash);

    const mockCtx: any = {
      db,
      job: { id: 'job-43-1', task_id: taskId, kind: 'pr.create' },
      payload: { taskId }
    };

    await handlePrCreate(mockCtx);

    // Verify branch pushed via refspec and PR created in fake provider
    expect(fakePrProvider.pushedBranches).toContain(`HEAD:refs/heads/bureau-wt-${taskId}`);
    expect(fakePrProvider.createdPrs).toHaveLength(1);
    expect(fakePrProvider.createdPrs[0].body).toContain(`Reviewed commit: ${tipHash}`);

    // Verify task table updated with PR URL
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task.pull_request_url).toContain('/pull/100');

    // Verify system journal span created for pr.create
    const spans = db.all("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'system' AND detail LIKE '%pr.create%'", taskId);
    expect(spans).toHaveLength(1);

    // Verify pr.merge job enqueued
    const mergeJobs = db.all("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'pr.merge'", taskId);
    expect(mergeJobs).toHaveLength(1);
  });

  it('refuses when operator approval is missing', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-43-unapproved';

    seedTaskRow(db, taskId, { approved: false, exitCode: 0 });
    const { tipHash } = await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', tipHash);

    const mockCtx: any = {
      db,
      job: { id: 'job-43-2', task_id: taskId, kind: 'pr.create' },
      payload: { taskId }
    };

    await expect(handlePrCreate(mockCtx)).rejects.toThrow(/lacks recorded operator approval/);

    // Guardrail span journaled
    const spans = db.all("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'", taskId);
    expect(spans).toHaveLength(1);
  });

  it('refuses when work review commit does not match branch tip', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-43-hash-mismatch';

    seedTaskRow(db, taskId, { approved: true, exitCode: 0 });
    await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', 'outdated-hash-999');

    const mockCtx: any = {
      db,
      job: { id: 'job-43-3', task_id: taskId, kind: 'pr.create' },
      payload: { taskId }
    };

    await expect(handlePrCreate(mockCtx)).rejects.toThrow(/work review commit \(outdated-hash-999\) does not match current branch tip/);

    const spans = db.all("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'", taskId);
    expect(spans).toHaveLength(1);
  });
});
