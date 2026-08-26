import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AttributionTuple, BureauJobRow, BureauTaskRow, DbConnection } from '../../engine/contract/types.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { setPrProviderOverride } from '../../engine/contract/pr-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { approveTask } from '../../engine/state/machine.ts';
// Importing the runner registers all job handlers as a module side effect, so
// drainSingleJob can execute worktree.prepare / verify.run / pr.create / pr.merge.
import { drainSingleJob } from '../../runner/main.ts';

/**
 * T45 — the delivery TAIL, seam-joined end to end.
 *
 * The roadmap review found that this tail is already wired in code but was only
 * covered per-stage (t41–t44), never as one continuous run through the chained
 * job queue. This test locks it: from a walkthrough APPROVE, a task travels
 *   work-review approve → worktree.prepare → verify.run → needs-review
 *   → operator approve (the human gate) → pr.create → pr.merge → done
 * driven ONLY by draining the queue and the sanctioned operator door
 * (approveTask) — never by a direct state write. If any link in the chain
 * regresses, this test fails.
 */
describe('T45: delivery tail — walkthrough APPROVE drains all the way to done', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    setSeniorDriverOverride(null);
    setPrProviderOverride(null);
    setWorkspaceProvider(null);
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  /** Drain ready jobs one at a time until `predicate` holds or the queue empties. */
  async function drainUntil(db: DbConnection, predicate: () => boolean, maxSteps = 40): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      if (predicate()) return;
      const next = db.get<BureauJobRow>(
        `SELECT * FROM bureau_jobs WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?)
          ORDER BY created_at ASC, id ASC LIMIT 1`,
        new Date().toISOString()
      );
      if (!next) break;
      await drainSingleJob(db, next.id);
    }
  }

  it('reaches done through the tracked path with no direct state writes', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t45-'));
    const repoPath = path.join(tempDir, 'repo');
    const dbPath = path.join(tempDir, 'test.db');

    // Real git repo so reviewed_commit / branch tips are genuine hashes.
    fs.mkdirSync(repoPath, { recursive: true });
    git(['init'], repoPath);
    git(['config', 'user.name', 'Bureau Runner'], repoPath);
    git(['config', 'user.email', 'runner@bureau.local'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# T45 Repo\n');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'initial'], repoPath);
    git(['branch', '-M', 'main'], repoPath);

    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);
    const pr = new FakePrProvider();
    setPrProviderOverride(pr);
    // The senior approves the walkthrough (fail-closed parsing lives in senior.ts;
    // here we inject a clean APPROVE to exercise the delivery tail, not review).
    setSeniorDriverOverride({
      review: async () => ({ senior: 'zai', verdict: 'approve', feedback: 'work matches the task', raw: 'VERDICT: APPROVE', model: 'glm-test' })
    } as any);

    const db = openDbConnection(dbPath);
    const taskId = 't45-task';
    const now = new Date().toISOString();

    // Seed a task mid-flow: implemented, sitting in `claimed`, ready for its
    // walkthrough to be reviewed. verify_cmd exits 0 without touching the repo.
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, cycles, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'T45 tail', 'wire the tail', 'spec', 'accept', 'node --version', 'claimed', 0, 0, 1, 'wuuid-45', ?, ?)`,
      taskId, now, now
    );

    // The junior implemented IN the task's bureau worktree: prepare it and land a
    // real commit there (its "work"), so the reviewed_commit is that tip.
    const handle = await provider.prepare(db, taskId);
    fs.writeFileSync(path.join(handle.path, 'feature.txt'), 'the junior implemented this\n');
    git(['add', '-A'], handle.path);
    git(['commit', '-m', 'junior: implement feature'], handle.path);
    const juniorTip = git(['rev-parse', 'HEAD'], handle.path);

    // --- Walkthrough review → APPROVE ---
    const review = await runWorkReviewCycle(db, {
      taskId,
      seniorId: 'zai',
      walkthrough: 'Implemented feature.txt; ran the suite; all green.'
    });
    expect(review.outcome).toBe('approved');

    // reviewed_commit must be the junior's tip, so pr.create/pr.merge deliver the
    // ACTUAL work (not an empty diff).
    const wr = db.get<{ reviewed_commit: string }>(
      "SELECT reviewed_commit FROM bureau_work_reviews WHERE task_id = ? AND verdict = 'approved' ORDER BY created_at DESC LIMIT 1",
      taskId
    );
    expect(wr?.reviewed_commit).toBe(juniorTip);

    // --- Drain to the human gate: worktree.prepare → verify.run → needs-review ---
    await drainUntil(db, () => db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!.state === 'needs-review');
    const atGate = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!;
    expect(atGate.state).toBe('needs-review');
    expect(atGate.verifier_exit_code).toBe(0);

    // --- The human gate: the operator approves (single-writer door) ---
    const operator: AttributionTuple = { actor_role: 'human-operator', provider: 'human', model: 'operator', account: 'admin' };
    approveTask(db, taskId, operator);

    // --- Drain delivery: pr.create → pr.merge → done ---
    await drainUntil(db, () => db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!.state === 'done');

    // === The tracked path completed, DB-proven ===
    const done = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!;
    expect(done.state).toBe('done');
    expect(done.merged_at).toBeTruthy();
    expect(done.merged_by).toBe('system');

    // Every delivery job ran to completion.
    for (const kind of ['worktree.prepare', 'verify.run', 'pr.create', 'pr.merge']) {
      const job = db.get<BureauJobRow>(
        'SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
        taskId, kind
      );
      expect(job, `job ${kind} should exist`).toBeTruthy();
      expect(job!.state, `job ${kind} should be done`).toBe('done');
    }

    // The PR was really pushed, created, and merged through the seam.
    expect(pr.pushedBranches.length).toBeGreaterThan(0);
    expect(pr.createdPrs.length).toBe(1);
    expect(pr.mergedPrs.length).toBe(1);

    // A merge transition span exists for this task — the delivery-path evidence
    // the merge law (merge_guard) later relies on.
    const mergeSpan = db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM bureau_journal WHERE task_id = ? AND kind = 'transition' AND detail LIKE '%\"action\":\"merge\"%'",
      taskId
    );
    expect(mergeSpan!.n).toBeGreaterThan(0);
  });
});
