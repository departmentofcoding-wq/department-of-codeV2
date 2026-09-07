import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { handleDeliveryFreshen, FRESHEN_CYCLE_BUDGET } from '../../engine/delivery/freshen.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';

/**
 * delivery.freshen — the delivery-conflict recovery (2026-09-06: PRs #9/#11
 * died "not mergeable" after 3 identical retries and stranded approved tasks).
 *
 * The load-bearing guarantees under test (the non-destruction guardrails):
 *  1. A real conflict is ABORTED, never auto-resolved: the branch tip and the
 *     worktree are byte-identical to before the attempt.
 *  2. A clean merge re-verifies (semantic conflicts caught) and re-enters the
 *     delivery tail at the phase4 review gate — never around it.
 *  3. The task NEVER leaves needs-review; budgets exhaust loudly.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('tc: delivery.freshen (delivery-conflict recovery)', () => {
  let tempDir: string;
  let originPath: string;
  let seedPath: string;
  let repoPath: string;
  let dbPath: string;
  let gitWorkspaceProvider: GitWorkspaceProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-tc-freshen-'));
    originPath = path.join(tempDir, 'origin.git');
    seedPath = path.join(tempDir, 'seed');
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    // A bare origin plus a seed clone that advances main, and the task repo
    // the worktrees live in — mirroring the real moving-main topology. The
    // bare's HEAD is otherwise unborn, so clone --branch main explicitly.
    execFileSync('git', ['init', '--bare', originPath]);
    fs.mkdirSync(seedPath, { recursive: true });
    git(seedPath, ['init']);
    git(seedPath, ['config', 'user.name', 'Test User']);
    git(seedPath, ['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(seedPath, 'README.md'), '# Seed Repo');
    git(seedPath, ['add', 'README.md']);
    git(seedPath, ['commit', '-m', 'initial commit']);
    git(seedPath, ['branch', '-M', 'main']);
    git(seedPath, ['remote', 'add', 'origin', originPath]);
    git(seedPath, ['push', '-u', 'origin', 'main']);

    execFileSync('git', ['clone', '--branch', 'main', originPath, repoPath]);
    git(repoPath, ['config', 'user.name', 'Test User']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    // Byte-exact assertions on file content — no autocrlf surprises.
    git(repoPath, ['config', 'core.autocrlf', 'false']);

    gitWorkspaceProvider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(gitWorkspaceProvider);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function seedTask(db: any, taskId: string, opts?: { verifyCmd?: string; state?: string }) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, approved_at, approved_by, verify_cmd, work_uuid, created_at, updated_at)
       VALUES (?, 'Freshen Task', 'Test intent', ?, 0, ?, 'human-operator:admin', ?, 'work-uuid', ?, ?)`,
      taskId,
      opts?.state || 'needs-review',
      now,
      opts?.verifyCmd ?? 'node --version',
      now,
      now
    );
  }

  async function prepareWorktree(db: any, taskId: string) {
    const handle = await gitWorkspaceProvider.prepare(db, taskId);
    return handle.path;
  }

  function advanceMainOnOrigin(file: string, content: string) {
    fs.writeFileSync(path.join(seedPath, file), content);
    git(seedPath, ['add', file]);
    git(seedPath, ['commit', '-m', `main advances ${file}`]);
    git(seedPath, ['push', 'origin', 'main']);
  }

  function commitInWorktree(wtPath: string, file: string, content: string, message: string) {
    fs.writeFileSync(path.join(wtPath, file), content);
    git(wtPath, ['add', file]);
    git(wtPath, ['commit', '-m', message]);
  }

  function makeCtx(db: any, taskId: string) {
    const jobId = `job-freshen-${taskId}`;
    // journal() enforces job_id → bureau_jobs(id); the runner always has a
    // real claimed job row, so the mock stands one up.
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, run_after, attempts, max_attempts, reaped_count, created_at)
       VALUES (?, 'delivery.freshen', ?, '{}', 'running', NULL, 0, 3, 0, ?)`,
      jobId,
      taskId,
      new Date().toISOString()
    );
    return {
      db,
      job: { id: jobId, task_id: taskId, kind: 'delivery.freshen' },
      payload: { taskId }
    } as any;
  }

  function guardrailSpans(db: any, taskId: string): any[] {
    return db
      .all(`SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'`, taskId)
      .map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  it('REAL conflict: merge is aborted, branch tip and worktree stay pristine, conflict reported, task held at needs-review', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-conflict-1';
    seedTask(db, taskId);
    const wtPath = await prepareWorktree(db, taskId);

    // The task edits shared.txt on its branch…
    commitInWorktree(wtPath, 'shared.txt', 'task version\n', 'task edits shared');
    // …while main moves the SAME file — a genuine content conflict.
    advanceMainOnOrigin('shared.txt', 'main version\n');

    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);
    await handleDeliveryFreshen(makeCtx(db, taskId));

    // Non-destruction guardrail: tip unchanged, tree clean, task's edit intact.
    expect(git(wtPath, ['rev-parse', 'HEAD'])).toBe(tipBefore);
    expect(git(wtPath, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(wtPath, 'shared.txt'), 'utf-8')).toBe('task version\n');

    // The conflict is reported with the conflicting file named.
    const conflictSpan = guardrailSpans(db, taskId).find((s) => s.detail.status === 'conflict');
    expect(conflictSpan).toBeDefined();
    expect(conflictSpan.detail.action).toBe('delivery.freshen');
    expect(conflictSpan.detail.files).toContain('shared.txt');

    // No verification ran and the delivery tail was NOT entered.
    expect(db.get<any>('SELECT COUNT(*) n FROM bureau_verify_runs WHERE task_id = ?', taskId).n).toBe(0);
    expect(db.get<any>("SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'work.diff-review'", taskId).n).toBe(0);

    // The task never left the human gate.
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', taskId).state).toBe('needs-review');
  });

  it('CLEAN freshen: merges origin/main, re-verifies (exit 0), queues the phase4 diff-review at the new tip', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-clean-1';
    seedTask(db, taskId);
    const wtPath = await prepareWorktree(db, taskId);

    commitInWorktree(wtPath, 'task-file.txt', 'task work\n', 'task work');
    advanceMainOnOrigin('main-file.txt', 'main moved\n');

    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);
    await handleDeliveryFreshen(makeCtx(db, taskId));

    // The merge commit landed on the branch.
    const tipAfter = git(wtPath, ['rev-parse', 'HEAD']);
    expect(tipAfter).not.toBe(tipBefore);
    expect(git(wtPath, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(wtPath, 'main-file.txt'))).toBe(true);

    // Re-verification ran and passed, and is recorded as a real verify run.
    const run = db.get<any>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
    expect(run).toBeDefined();
    expect(run.exit_code).toBe(0);

    // The delivery tail re-enters at the review gate (not around it).
    const review = db.all<any>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'work.diff-review'", taskId);
    expect(review).toHaveLength(1);
    expect(review[0].state).toBe('pending');

    const cleanSpan = db
      .all(`SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'system'`, taskId)
      .map((r: any) => JSON.parse(r.detail))
      .find((d: any) => d.action === 'delivery.freshen' && d.status === 'clean');
    expect(cleanSpan).toBeDefined();
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', taskId).state).toBe('needs-review');
  });

  it('UNTRACKED artifacts present: freshen still proceeds (does NOT false-fail FRESHEN_DIRTY_TREE)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-untracked-1';
    seedTask(db, taskId);
    const wtPath = await prepareWorktree(db, taskId);

    commitInWorktree(wtPath, 'task-file.txt', 'task work\n', 'task work');
    advanceMainOnOrigin('main-file.txt', 'main moved\n');

    // The engine writes untracked docs/junior-artifacts/** into worktrees, and
    // non-dept repos don't inherit this repo's .gitignore — so an untracked
    // artifact must NOT trip the dirty-tree guard (git merge tolerates it).
    fs.mkdirSync(path.join(wtPath, 'docs', 'junior-artifacts', 'x'), { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'docs', 'junior-artifacts', 'x', 'walkthrough.md'), 'untracked artifact\n');
    // Sanity: a full porcelain WOULD see it (proving the guard would have tripped).
    expect(git(wtPath, ['status', '--porcelain'])).not.toBe('');

    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);
    await handleDeliveryFreshen(makeCtx(db, taskId));

    // Freshen proceeded (clean path), NOT refused: tip advanced, no DIRTY_TREE span.
    expect(git(wtPath, ['rev-parse', 'HEAD'])).not.toBe(tipBefore);
    expect(guardrailSpans(db, taskId).find((s) => s.detail.reason === 'worktree dirty at freshen start')).toBeUndefined();
    expect(db.get<any>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId).exit_code).toBe(0);
    // The untracked artifact is still there, untouched.
    expect(fs.existsSync(path.join(wtPath, 'docs', 'junior-artifacts', 'x', 'walkthrough.md'))).toBe(true);
  });

  it('SEMANTIC conflict: clean git merge but failing verify — reported, merge commit kept, delivery tail NOT entered', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-semantic-1';
    seedTask(db, taskId, { verifyCmd: 'node -e "process.exit(3)"' });
    const wtPath = await prepareWorktree(db, taskId);

    commitInWorktree(wtPath, 'task-file.txt', 'task work\n', 'task work');
    advanceMainOnOrigin('main-file.txt', 'main moved\n');

    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);
    await handleDeliveryFreshen(makeCtx(db, taskId));

    // The merge stays (honest progress; rollback would need a forbidden reset).
    expect(git(wtPath, ['rev-parse', 'HEAD'])).not.toBe(tipBefore);

    const failSpan = guardrailSpans(db, taskId).find((s) => s.detail.status === 'reverify_failed');
    expect(failSpan).toBeDefined();
    expect(failSpan.detail.exit_code).toBe(3);

    const run = db.get<any>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
    expect(run.exit_code).toBe(3);

    expect(db.get<any>("SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'work.diff-review'", taskId).n).toBe(0);
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', taskId).state).toBe('needs-review');
  });

  it('budget: at the cycle ceiling the freshen does NO git work and exhausts loudly', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-budget-1';
    seedTask(db, taskId);
    const wtPath = await prepareWorktree(db, taskId);

    // Two terminal prior cycles (this test's job does not count itself).
    for (let i = 0; i < FRESHEN_CYCLE_BUDGET; i++) {
      const job = enqueueJob(db, { kind: 'delivery.freshen', task_id: taskId, payload: { taskId } });
      db.run('UPDATE bureau_jobs SET state = ? WHERE id = ?', 'done', job.id);
    }

    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);
    await handleDeliveryFreshen(makeCtx(db, taskId));

    expect(git(wtPath, ['rev-parse', 'HEAD'])).toBe(tipBefore);
    const span = guardrailSpans(db, taskId).find((s) => s.detail.status === 'budget_exhausted');
    expect(span).toBeDefined();
    expect(span.detail.cycles).toBe(FRESHEN_CYCLE_BUDGET);
    expect(db.get<any>('SELECT COUNT(*) n FROM bureau_verify_runs WHERE task_id = ?', taskId).n).toBe(0);
  });

  it('off-gate: a task not at needs-review is refused non-retryably, no git work', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-offgate-1';
    seedTask(db, taskId, { state: 'claimed' });
    const wtPath = await prepareWorktree(db, taskId);

    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);
    let err: any;
    try {
      await handleDeliveryFreshen(makeCtx(db, taskId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.nonRetryable).toBe(true);
    expect(err.code).toBe('FRESHEN_OFF_GATE');
    expect(git(wtPath, ['rev-parse', 'HEAD'])).toBe(tipBefore);
  });

  it('dirty tree: uncommitted TRACKED edits are refused protection — freshen never merges over them', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'freshen-dirty-1';
    seedTask(db, taskId);
    const wtPath = await prepareWorktree(db, taskId);

    // A TRACKED modification is the real dirty class the guard protects against
    // (untracked files no longer count — see the untracked-artifacts test). README
    // is tracked from the seed repo, so an uncommitted edit to it is a dirty tree.
    fs.appendFileSync(path.join(wtPath, 'README.md'), 'junior WIP edit\n');
    const tipBefore = git(wtPath, ['rev-parse', 'HEAD']);

    let err: any;
    try {
      await handleDeliveryFreshen(makeCtx(db, taskId));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('FRESHEN_DIRTY_TREE');

    // The junior's uncommitted work is untouched on disk.
    expect(fs.readFileSync(path.join(wtPath, 'README.md'), 'utf-8')).toContain('junior WIP edit');
    expect(git(wtPath, ['rev-parse', 'HEAD'])).toBe(tipBefore);
  });
});
