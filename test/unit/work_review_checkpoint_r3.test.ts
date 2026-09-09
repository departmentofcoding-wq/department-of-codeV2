import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbConnection, WorkspaceProvider } from '../../engine/contract/index.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-r3-'));
      const db = createRealSqliteDb(path.join(tmpDir, 'test.db'));
      return {
        db,
        cleanup: () => {
          db.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      };
    }
  }
];

/** Workspace provider with injectable checkpoint/isClean behavior. */
class StubWorkspaceProvider implements WorkspaceProvider {
  public checkpointCalls = 0;
  constructor(
    private readonly wsPath: string,
    private readonly behavior: { checkpointThrows?: boolean; cleanAfterCheckpoint?: boolean } = {}
  ) {}
  public async prepare(_db: DbConnection, taskId: string) {
    return { taskId, path: this.wsPath, baseCommit: 'base' };
  }
  public async getWorkspaceHandle(_db: DbConnection, taskId: string) {
    return { taskId, path: this.wsPath, baseCommit: 'base' };
  }
  public async isClean(): Promise<boolean> {
    return this.behavior.cleanAfterCheckpoint ?? false;
  }
  public async checkpoint(): Promise<void> {
    this.checkpointCalls++;
    if (this.behavior.checkpointThrows) {
      throw new Error('simulated git failure (lock/identity)');
    }
  }
  public async prune(): Promise<void> {}
}

function setupTaskWithWorktree(db: DbConnection, taskId: string, worktreeDir: string): string {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, cycles, priority, work_uuid, work_title,
       assigned_junior, assigned_senior, assigned_at, created_at, updated_at)
     VALUES (?, 'R3 task', 'claimed', 0, 1, ?, ?, 'A', 'zai', ?, ?, ?)`,
    taskId,
    `work-${taskId}`,
    `Task ${taskId}`,
    now,
    now,
    now
  );
  enqueueJob(db, { id: `job-${taskId}`, kind: 'work.cycle', task_id: taskId, payload: { taskId } });
  const tip = execSync('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf8' }).trim();
  db.run(
    `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model, account)
     VALUES (?, ?, ?, ?, 'ready', ?, ?, 'foreman', 'git', 'local', NULL)`,
    `wt-${taskId}`,
    taskId,
    worktreeDir,
    tip,
    now,
    now
  );
  return tip;
}

describe.each(testImplementations)('R3: work-review approve checkpoint ($name)', ({ create }) => {
  let db: DbConnection;
  let cleanup: () => void;
  let worktreeDir: string;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;

    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-r3-wt-'));
    execSync('git init', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git config user.name "Bureau Test"', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git config user.email "test@bureau.local"', { cwd: worktreeDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktreeDir, 'app.js'), 'console.log(1);\n');
    execSync('git add app.js', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git commit -m base', { cwd: worktreeDir, stdio: 'ignore' });
    // The junior's approved work, staged but uncommitted (the incident state).
    fs.writeFileSync(path.join(worktreeDir, 'app.js'), 'console.log(2);\n');
    execSync('git add app.js', { cwd: worktreeDir, stdio: 'ignore' });

    setSeniorDriverOverride({
      review: async () => ({
        senior: 'zai',
        verdict: 'approve',
        feedback: 'walkthrough approved',
        raw: 'VERDICT: APPROVE',
        model: 'glm-test'
      })
    } as any);
  });

  afterEach(() => {
    setSeniorDriverOverride(null);
    setWorkspaceProvider(null);
    if (worktreeDir && fs.existsSync(worktreeDir)) {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
    cleanup();
  });

  it('checkpoint THROWS: task blocked with named reason, NO false reviewed_commit, no worktree.prepare, loud span, one retry', async () => {
    const taskId = 'task-r3-throw';
    setupTaskWithWorktree(db, taskId, worktreeDir);
    const provider = new StubWorkspaceProvider(worktreeDir, { checkpointThrows: true });
    setWorkspaceProvider(provider);

    const res = await runWorkReviewCycle(db, { taskId, walkthrough: 'I implemented it.', jobId: 'job-task-r3-throw' });

    expect(res.outcome).toBe('blocked');
    if (res.outcome === 'blocked') {
      expect(res.reason).toBe('checkpoint_failed_after_approve');
    }
    // One retry before giving up.
    expect(provider.checkpointCalls).toBe(2);

    const task = db.get<{ state: string }>('SELECT state FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('blocked');

    const review = db.get<{ reviewed_commit: string | null; verdict: string }>(
      'SELECT reviewed_commit, verdict FROM bureau_work_reviews WHERE task_id = ?',
      taskId
    );
    expect(review?.verdict).toBe('approved');
    expect(review?.reviewed_commit).toBeNull();

    const span = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = ?`,
      taskId
    );
    expect(span?.detail).toContain('checkpoint_failed');

    const prepare = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'worktree.prepare'`,
      taskId
    );
    expect(prepare?.n).toBe(0);
  });

  it('checkpoint no-ops and the tree stays DIRTY: same refusal — never record reviewed_commit = base tip', async () => {
    const taskId = 'task-r3-dirty';
    setupTaskWithWorktree(db, taskId, worktreeDir);
    setWorkspaceProvider(new StubWorkspaceProvider(worktreeDir, { cleanAfterCheckpoint: false }));

    const res = await runWorkReviewCycle(db, { taskId, walkthrough: 'I implemented it.', jobId: 'job-task-r3-dirty' });

    expect(res.outcome).toBe('blocked');
    const task = db.get<{ state: string }>('SELECT state FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('blocked');

    const review = db.get<{ reviewed_commit: string | null }>(
      'SELECT reviewed_commit FROM bureau_work_reviews WHERE task_id = ?',
      taskId
    );
    expect(review?.reviewed_commit).toBeNull();
  });

  it('checkpoint SUCCEEDS (tree clean): reviewed_commit = real tip and delivery chain enqueued', async () => {
    const taskId = 'task-r3-ok';
    const tip = setupTaskWithWorktree(db, taskId, worktreeDir);
    setWorkspaceProvider(new StubWorkspaceProvider(worktreeDir, { cleanAfterCheckpoint: true }));

    const res = await runWorkReviewCycle(db, { taskId, walkthrough: 'I implemented it.', jobId: 'job-task-r3-ok' });

    expect(res.outcome).toBe('approved');
    const review = db.get<{ reviewed_commit: string | null }>(
      'SELECT reviewed_commit FROM bureau_work_reviews WHERE task_id = ?',
      taskId
    );
    expect(review?.reviewed_commit).toBe(tip);

    const task = db.get<{ state: string }>('SELECT state FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('claimed');

    const prepare = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'worktree.prepare'`,
      taskId
    );
    expect(prepare?.n).toBe(1);
  });
});
