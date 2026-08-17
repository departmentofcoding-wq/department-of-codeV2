import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { setWorkspaceProvider, getWorkspaceProvider, type AttributionTuple, type BureauTaskRow } from '../../engine/contract/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { handleWorktreePrepare } from '../../engine/worktrees/job.ts';
import { drainSingleJob } from '../../runner/main.ts';

describe('T19 & T19b: Worktree Idempotency, Refuse-Dirty Invariant & Crash-Resume', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;

  function runGit(args: string[], cwd: string = repoPath): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t19-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    // Create throwaway test git repository
    fs.mkdirSync(repoPath, { recursive: true });
    runGit(['init'], repoPath);
    runGit(['config', 'user.name', 'Test Runner'], repoPath);
    runGit(['config', 'user.email', 'test@bureau.local'], repoPath);

    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Repo\n');
    runGit(['add', '.'], repoPath);
    runGit(['commit', '-m', 'Initial commit'], repoPath);
    runGit(['branch', '-M', 'main'], repoPath);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      // Force prune worktrees if needed before rm
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'ignore' });
      } catch {}
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const foremanAttr: AttributionTuple = {
    actor_role: 'foreman',
    provider: 'deterministic',
    model: 'core',
    account: null
  };

  function seedQueuedTask(db: any, taskId = 'task-t19'): BureauTaskRow {
    const now = new Date().toISOString();
    return db.get(`
      INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
      VALUES (?, 'T19 Task', 'queued', 'work-t19', ?, ?)
      RETURNING *
    `, taskId, now, now) as BureauTaskRow;
  }

  it('T19: Worktree create is idempotent per task; reuse-if-clean; dirty tree is refused and never force-deleted', async () => {
    const db = openDbConnection(dbPath);
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    seedQueuedTask(db, 't19-idempotent');

    // 1. Initial prepare creates clean worktree
    const handle1 = await provider.prepare(db, 't19-idempotent');
    expect(handle1.taskId).toBe('t19-idempotent');
    expect(fs.existsSync(handle1.path)).toBe(true);

    // 2. Prepare second time on clean tree -> returns same handle (idempotent reuse)
    const handle2 = await provider.prepare(db, 't19-idempotent');
    expect(handle2.path).toBe(handle1.path);
    expect(handle2.baseCommit).toBe(handle1.baseCommit);

    // 3. Make worktree dirty by writing uncommitted changes
    fs.writeFileSync(path.join(handle1.path, 'dirty_file.txt'), 'dirty work\n');
    expect(await provider.isClean(db, 't19-idempotent')).toBe(false);

    // 4. Prepare on dirty tree -> throws Error, worktree remains intact (never force-deleted!)
    await expect(provider.prepare(db, 't19-idempotent')).rejects.toThrow(/refusing to reuse or force-delete/);
    expect(fs.existsSync(handle1.path)).toBe(true);

    expect(fs.existsSync(path.join(handle1.path, 'dirty_file.txt'))).toBe(true);
  }, 15000);

  it('T19b: Crash-resume during worktree.prepare job handler (re-entry matrix test)', async () => {

    const db = openDbConnection(dbPath);
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    seedQueuedTask(db, 't19b-crash');

    // Scenario A: Job handler executes partially — crash after state transition 'queued' -> 'claimed' before worktree prepare completes
    db.prepare("UPDATE bureau_tasks SET state = 'claimed' WHERE id = 't19b-crash'").run();

    // Create worktree.prepare job
    const jobStmt = db.prepare(`
      INSERT INTO bureau_jobs (id, kind, task_id, payload, state, created_at)
      VALUES ('job-t19b', 'worktree.prepare', 't19b-crash', '{"taskId":"t19b-crash"}', 'pending', ?)
      RETURNING *
    `);
    const now = new Date().toISOString();
    const jobRow = jobStmt.get(now) as any;

    // Run worktree.prepare job handler on claimed task with no worktree DB row
    await handleWorktreePrepare({
      db,
      job: jobRow,
      payload: { taskId: 't19b-crash' },
      signal: new AbortController().signal
    });

    // Verify task is still claimed, worktree exists, and verify.run job was enqueued
    const task = db.get("SELECT state FROM bureau_tasks WHERE id = 't19b-crash'") as any;
    expect(task.state).toBe('claimed');

    const handle = await provider.getWorkspaceHandle(db, 't19b-crash');
    expect(fs.existsSync(handle.path)).toBe(true);

    const verifyJobs = db.all("SELECT * FROM bureau_jobs WHERE task_id = 't19b-crash' AND kind = 'verify.run'") as any[];
    expect(verifyJobs).toHaveLength(1);

    // Scenario B: Re-run worktree.prepare job when verify.run job is already pending (idempotent enqueue)
    await handleWorktreePrepare({
      db,
      job: jobRow,
      payload: { taskId: 't19b-crash' },
      signal: new AbortController().signal
    });

    // Verify no duplicate verify.run jobs were created
    const verifyJobsAfterRerun = db.all("SELECT * FROM bureau_jobs WHERE task_id = 't19b-crash' AND kind = 'verify.run'") as any[];
    expect(verifyJobsAfterRerun).toHaveLength(1);

    // Scenario C: Directory exists on disk but missing DB row (crash between git worktree add and DB insert)
    seedQueuedTask(db, 't19b-adopt');
    const unrecordedPath = path.join(repoPath, '.bureau-worktrees', 't19b-adopt');
    fs.mkdirSync(path.dirname(unrecordedPath), { recursive: true });
    runGit(['worktree', 'add', unrecordedPath, '-b', 'bureau-wt-t19b-adopt', 'main'], repoPath);

    // DB row does not exist yet
    const rowBefore = db.get("SELECT * FROM bureau_worktrees WHERE task_id = 't19b-adopt'");
    expect(rowBefore).toBeUndefined();

    // Prepare adopts the existing clean worktree directory and inserts the DB row
    const adoptedHandle = await provider.prepare(db, 't19b-adopt');
    expect(adoptedHandle.path).toBe(unrecordedPath);

    const rowAfter = db.get("SELECT status FROM bureau_worktrees WHERE task_id = 't19b-adopt'") as any;
    expect(rowAfter?.status).toBe('ready');
  }, 15000);
});


