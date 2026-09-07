import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { handlePrMerge } from '../../engine/delivery/pr_merge.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { setPrProviderOverride } from '../../engine/contract/pr-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

describe('T44: pr.merge Job Integration Test & Real Prune Path (B-7)', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let fakePrProvider: FakePrProvider;
  let gitWorkspaceProvider: GitWorkspaceProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t44-'));
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

  function seedTaskRow(db: any, taskId: string, opts?: { approved?: boolean; exitCode?: number; state?: string; prUrl?: string }) {
    const now = new Date().toISOString();
    const approvedAt = opts?.approved ? now : null;
    const approvedBy = opts?.approved ? 'human-operator:admin' : null;
    const state = opts?.state || 'needs-review';
    const exitCode = opts?.exitCode !== undefined ? opts.exitCode : 0;
    const prUrl = opts?.prUrl || 'https://github.com/bureau-fake/repo/pull/101';

    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, approved_at, approved_by, pull_request_url, work_uuid, created_at, updated_at)
       VALUES (?, 'T44 Task', 'Test intent', ?, ?, ?, ?, ?, 'work-uuid', ?, ?)`,
      taskId,
      state,
      exitCode,
      approvedAt,
      approvedBy,
      prUrl,
      now,
      now
    );
  }

  function seedWorkReview(db: any, taskId: string, verdict: string, commitHash: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
       VALUES (?, ?, 'work-uuid', 'phase4', 1, ?, ?, 'senior-engineer', 'zai', 'glm-5.2', ?)`,
      `wr-${Math.random()}`,
      taskId,
      verdict,
      commitHash,
      now
    );
  }

  it('happy path: merges PR inside transaction, transitions to done, sets merged_at/by, and prunes worktree (B-7)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-44-happy';

    seedTaskRow(db, taskId, { approved: true, exitCode: 0 });
    const { handle, tipHash } = await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', tipHash);

    // Verify worktree is ready and directory exists before merge
    expect(fs.existsSync(handle.path)).toBe(true);
    const wtRowBefore = db.get<any>('SELECT status FROM bureau_worktrees WHERE task_id = ?', taskId);
    expect(wtRowBefore.status).toBe('ready');

    const mockCtx: any = {
      db,
      job: { id: 'job-44-1', task_id: taskId, kind: 'pr.merge' },
      payload: { taskId, prNumber: 101 }
    };

    await handlePrMerge(mockCtx);

    // Verify PR merged in fake provider
    expect(fakePrProvider.mergedPrs).toContain(101);

    // N8: `gh pr merge` must run in the task's worktree so it resolves the PR
    // against the task's own project repo, not the dept repo. Captured at call
    // time (before the post-merge prune removed the directory).
    expect(fakePrProvider.mergeCwds[0]).toBe(handle.path);

    // Verify task state transitioned to 'done' and merged_at/merged_by populated
    const updatedTask = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(updatedTask.state).toBe('done');
    expect(updatedTask.merged_at).toBeDefined();
    expect(updatedTask.merged_by).toBe('system');

    // B-7: Verify real GitWorkspaceProvider prune executed:
    // status flipped to 'removed', directory unlinked, git worktree list clean
    const wtRowAfter = db.get<any>('SELECT status FROM bureau_worktrees WHERE task_id = ?', taskId);
    expect(wtRowAfter.status).toBe('removed');
    expect(fs.existsSync(handle.path)).toBe(false);

    const worktreeList = execSync('git worktree list', { cwd: repoPath, encoding: 'utf8' });
    expect(worktreeList).not.toContain(handle.path);
  });

  it('refuses when branch tip commit is modified after review (wrong hash)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-44-modified-commit';

    seedTaskRow(db, taskId, { approved: true, exitCode: 0 });
    const { handle, tipHash } = await seedTaskWithWorktree(db, taskId);

    // Seed review with matching tipHash
    seedWorkReview(db, taskId, 'approved', tipHash);

    // Make a new commit in the worktree branch after review
    fs.writeFileSync(path.join(handle.path, 'new_file.txt'), 'new content');
    execSync('git add new_file.txt', { cwd: handle.path });
    execSync('git commit -m "post-review modification"', { cwd: handle.path });

    const mockCtx: any = {
      db,
      job: { id: 'job-44-2', task_id: taskId, kind: 'pr.merge' },
      payload: { taskId, prNumber: 101 }
    };

    await expect(handlePrMerge(mockCtx)).rejects.toThrow(/does not match current tip/);

    // Verify no merge occurred, task state remains 'needs-review', worktree remains intact
    expect(fakePrProvider.mergedPrs).not.toContain(101);
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task.state).toBe('needs-review');
    expect(task.merged_at).toBeNull();

    // Guardrail span journaled OUTSIDE transaction
    const spans = db.all("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'", taskId);
    expect(spans).toHaveLength(1);
  });

  it('refuses when operator approval is missing', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-44-unapproved';

    seedTaskRow(db, taskId, { approved: false, exitCode: 0 });
    const { tipHash } = await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', tipHash);

    const mockCtx: any = {
      db,
      job: { id: 'job-44-3', task_id: taskId, kind: 'pr.merge' },
      payload: { taskId, prNumber: 101 }
    };

    await expect(handlePrMerge(mockCtx)).rejects.toThrow(/lacks operator approval/);

    expect(fakePrProvider.mergedPrs).not.toContain(101);
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task.state).toBe('needs-review');
  });

  it('classifies "not mergeable" as a delivery conflict: non-retryable on the FIRST attempt, queues delivery.freshen, journals delivery_conflict, task held at needs-review', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-44-delivery-conflict';

    seedTaskRow(db, taskId, { approved: true, exitCode: 0 });
    const { tipHash } = await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', tipHash);

    // The exact gh failure text from the 2026-09-06 incidents (PRs #9/#11).
    fakePrProvider.shouldFailMerge = true;
    fakePrProvider.failReason =
      'X Pull request departmentofcoding-wq/department-of-codeV2#9 is not mergeable: the merge commit cannot be cleanly created.\n' +
      'To have the pull request merged after all the requirements have been met, add the `--auto` flag.';

    const mockCtx: any = {
      db,
      job: { id: 'job-44-4', task_id: taskId, kind: 'pr.merge' },
      payload: { taskId, prNumber: 101 }
    };

    let err: any;
    try {
      await handlePrMerge(mockCtx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // Non-retryable: the runner's failJob(forceTerminal) keys off this flag.
    // Before the fix this was a plain DeliveryError and the identical
    // `gh pr merge` burned all 3 attempts (the zombie loop).
    expect(err.nonRetryable).toBe(true);
    expect(err.code).toBe('PR_MERGE_NOT_MERGEABLE');

    // Recovery is queued, exactly once.
    const freshenJobs = db.all<any>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'delivery.freshen'", taskId);
    expect(freshenJobs).toHaveLength(1);
    expect(freshenJobs[0].state).toBe('pending');

    // The conflict is journaled with the PR number and the recovery link.
    const spans = db
      .all("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'", taskId)
      .map((r: any) => JSON.parse(r.detail));
    const conflictSpan = spans.find((d: any) => d.status === 'delivery_conflict');
    expect(conflictSpan).toBeDefined();
    expect(conflictSpan.prNumber).toBe(101);

    // The task stays at the human gate — no state damage.
    const task = db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', taskId);
    expect(task.state).toBe('needs-review');
  });

  it('other provider failures stay retryable and queue NO freshen (only the deterministic conflict class is terminal)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-44-transient-failure';

    seedTaskRow(db, taskId, { approved: true, exitCode: 0 });
    const { tipHash } = await seedTaskWithWorktree(db, taskId);
    seedWorkReview(db, taskId, 'approved', tipHash);

    fakePrProvider.shouldFailMerge = true;
    fakePrProvider.failReason = 'gh: fetch failed: network socket hung up';

    const mockCtx: any = {
      db,
      job: { id: 'job-44-5', task_id: taskId, kind: 'pr.merge' },
      payload: { taskId, prNumber: 101 }
    };

    let err: any;
    try {
      await handlePrMerge(mockCtx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('PR_MERGE_PROVIDER_FAILED');
    expect(err.nonRetryable).toBeUndefined();

    expect(db.get<any>("SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'delivery.freshen'", taskId).n).toBe(0);
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', taskId).state).toBe('needs-review');
  });
});
