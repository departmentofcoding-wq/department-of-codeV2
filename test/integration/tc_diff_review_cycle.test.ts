import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { runDiffReviewCycle } from '../../engine/flow/diff_review_cycle.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

/**
 * The CODE-DIFF (phase4) senior review that gates delivery. Verifies the cycle
 * reviews the REAL diff through the harness senior, records a phase4 review at the
 * branch tip, chains to pr.create on APPROVE, holds on AMEND, and dedups when an
 * approved phase4 review already stands at the tip.
 */
describe('Diff-review cycle — the phase4 code-diff gate', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    setSeniorDriverOverride(null);
    setWorkspaceProvider(null);
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  /** Real git repo + a prepared bureau worktree carrying a committed change, with
   *  the task seeded in needs-review. Returns { db, taskId, tip }. */
  async function setup(): Promise<{ db: DbConnection; taskId: string; tip: string }> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-diffrev-'));
    const repoPath = path.join(tempDir, 'repo');
    const dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(repoPath, { recursive: true });
    git(['init'], repoPath);
    git(['config', 'user.name', 'Bureau Runner'], repoPath);
    git(['config', 'user.email', 'runner@bureau.local'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Repo\n');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'initial'], repoPath);
    git(['branch', '-M', 'main'], repoPath);

    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    const db = openDbConnection(dbPath);
    const taskId = 'diffrev-task';
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verifier_exit_code, verify_fixes, cycles, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'Add subtract', 'add subtract() to math', 'spec', 'subtract works', 'node --version', 'needs-review', 0, 0, 0, 1, 'wuuid-dr', ?, ?)`,
      taskId, now, now
    );

    // The junior implemented IN the task's bureau worktree: a real commit there
    // is the tip the diff-review reads and keys its phase4 row on.
    const handle = await provider.prepare(db, taskId);
    fs.writeFileSync(path.join(handle.path, 'math.js'), 'function subtract(a,b){return a-b;}\n');
    git(['add', '-A'], handle.path);
    git(['commit', '-m', 'junior: add subtract'], handle.path);
    const tip = git(['rev-parse', 'HEAD'], handle.path);

    return { db, taskId, tip };
  }

  it('APPROVE: reviews the real diff, records a phase4 review at the tip, chains to pr.create', async () => {
    const { db, taskId, tip } = await setup();

    let sawKind = '';
    let sawDiff = '';
    setSeniorDriverOverride({
      review: async (input: any) => {
        sawKind = input.kind;
        sawDiff = input.diff ?? '';
        return { senior: 'zai', verdict: 'approve', feedback: 'diff is sound', raw: 'VERDICT: APPROVE', model: 'glm-test' };
      }
    } as any);

    const res = await runDiffReviewCycle(db, { taskId, seniorId: 'zai' });
    expect(res.outcome).toBe('approved');

    // The senior saw the CODE DIFF, not a walkthrough.
    expect(sawKind).toBe('diff');
    expect(sawDiff).toContain('subtract');

    // A phase4 review row keyed on the exact tip.
    const wr = db.get<any>(
      "SELECT * FROM bureau_work_reviews WHERE task_id = ? AND phase = 'phase4' ORDER BY created_at DESC LIMIT 1",
      taskId
    );
    expect(wr.verdict).toBe('approved');
    expect(wr.reviewed_commit).toBe(tip);
    expect(wr.provider).toBe('zai');

    // Delivery was chained.
    const prJobs = db.all<any>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'pr.create'", taskId);
    expect(prJobs).toHaveLength(1);
  });

  it('AMEND: records a phase4 amend and HOLDS — no pr.create, task stays needs-review', async () => {
    const { db, taskId } = await setup();

    setSeniorDriverOverride({
      review: async () => ({ senior: 'zai', verdict: 'revise', feedback: 'handle b>a', raw: 'VERDICT: REVISE', model: 'glm-test' })
    } as any);

    const res = await runDiffReviewCycle(db, { taskId, seniorId: 'zai' });
    expect(res.outcome).toBe('amend');

    const wr = db.get<any>(
      "SELECT * FROM bureau_work_reviews WHERE task_id = ? AND phase = 'phase4' ORDER BY created_at DESC LIMIT 1",
      taskId
    );
    expect(wr.verdict).toBe('amend');

    // Nothing delivered; the human gate is untouched.
    expect(db.get<any>("SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'pr.create'", taskId).n).toBe(0);
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', taskId).state).toBe('needs-review');
  });

  it('DEDUP: an approved phase4 review already at the tip skips the senior and chains to delivery', async () => {
    const { db, taskId, tip } = await setup();

    // A prior approved phase4 review at the current tip (a re-drive, or recorded
    // elsewhere). The senior must NOT be called.
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES ('pre-phase4', ?, 'wuuid-dr', 'phase4', 0, 'approved', 'already reviewed', ?, 'senior-engineer', 'zai', 'glm', NULL, ?)`,
      taskId, tip, new Date().toISOString()
    );

    let seniorCalled = false;
    setSeniorDriverOverride({
      review: async () => {
        seniorCalled = true;
        throw new Error('senior should not be called on dedup');
      }
    } as any);

    const res = await runDiffReviewCycle(db, { taskId, seniorId: 'zai' });
    expect(res.outcome).toBe('already-approved');
    expect(seniorCalled).toBe(false);
    expect(db.get<any>("SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = 'pr.create'", taskId).n).toBe(1);
  });

  it('off-gate: a task NOT in needs-review is skipped without a review or a senior call', async () => {
    const { db, taskId } = await setup();
    db.run("UPDATE bureau_tasks SET state = 'claimed' WHERE id = ?", taskId);

    let seniorCalled = false;
    setSeniorDriverOverride({ review: async () => { seniorCalled = true; return { senior: 'zai', verdict: 'approve', feedback: '', raw: '', model: 'x' }; } } as any);

    const res = await runDiffReviewCycle(db, { taskId, seniorId: 'zai' });
    expect(res.outcome).toBe('skipped');
    expect(seniorCalled).toBe(false);
    expect(db.get<any>("SELECT COUNT(*) n FROM bureau_work_reviews WHERE task_id = ? AND phase = 'phase4'", taskId).n).toBe(0);
  });
});
