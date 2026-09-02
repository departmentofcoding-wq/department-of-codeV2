import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { handlePrCreate } from '../../engine/delivery/pr_create.ts';
import { handlePrMerge } from '../../engine/delivery/pr_merge.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { setPrProviderOverride } from '../../engine/contract/pr-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

/**
 * N2 — the delivery gate requires a phase4 code-diff senior approval AT THE TIP.
 *
 * Incidents (docs/plan-pre-phase8-remaining.md §N2): b55e2fda's delivery gate was
 * a `phase='walkthrough'` review; N1a likewise merged "flow-complete, not
 * diff-verified" — because pr.create/pr.merge read the LATEST
 * `bureau_work_reviews` row regardless of phase. The gate now keys on the latest
 * APPROVED `phase='phase4'` review and still enforces `reviewed_commit == tip`.
 */
describe('N2: delivery gate requires a phase4 code-diff review at the tip', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let fakePrProvider: FakePrProvider;
  let gitWorkspaceProvider: GitWorkspaceProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n2-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(repoPath, { recursive: true });
    git(['init'], repoPath);
    git(['config', 'user.name', 'Test User'], repoPath);
    git(['config', 'user.email', 'test@example.com'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Temp Repo');
    git(['add', 'README.md'], repoPath);
    git(['commit', '-m', 'initial commit'], repoPath);
    git(['branch', '-M', 'main'], repoPath);

    fakePrProvider = new FakePrProvider();
    setPrProviderOverride(fakePrProvider);
    gitWorkspaceProvider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(gitWorkspaceProvider);
  });

  afterEach(() => {
    setPrProviderOverride(null);
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  async function seedDeliveryReadyTask(db: any, taskId: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, approved_at, approved_by, work_uuid, created_at, updated_at)
       VALUES (?, 'N2 Task', 'intent', 'needs-review', 0, ?, 'human-operator:admin', 'wuuid-n2', ?, ?)`,
      taskId, now, now, now
    );
    const handle = await gitWorkspaceProvider.prepare(db, taskId);
    // The junior's committed work — the real branch tip.
    fs.writeFileSync(path.join(handle.path, 'feature.txt'), 'implemented\n');
    git(['add', '-A'], handle.path);
    git(['commit', '-m', 'junior: implement'], handle.path);
    const tip = git(['rev-parse', 'HEAD'], handle.path);
    return { handle, tip };
  }

  function seedReview(
    db: any,
    taskId: string,
    phase: string,
    verdict: string,
    commit: string | null,
    seq: number
  ) {
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES (?, ?, 'wuuid-n2', ?, 1, ?, '', ?, 'senior-engineer', 'zai', 'glm-5.3', NULL, ?)`,
      `wr-n2-${seq}-${Math.random()}`, taskId, phase, verdict, commit,
      new Date(Date.now() + seq).toISOString()
    );
  }

  function guardrailRefusals(db: any, taskId: string): any[] {
    return db.all(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = ? AND detail LIKE '%"status":"refused"%'`,
      taskId
    );
  }

  // --- pr.create: the refuse paths (fail-closed + journaled) ---

  it('pr.create REFUSES a task whose only approved review is walkthrough-phase at the tip (the N1a incident)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-walkthrough';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    seedReview(db, taskId, 'walkthrough', 'approved', tip, 1);

    await expect(
      handlePrCreate({ db, job: { id: 'j1', kind: 'pr.create', task_id: taskId } as any, payload: { taskId }, signal: new AbortController().signal })
    ).rejects.toThrow(/phase4 code-diff review/);

    // Fail-closed AND journaled — the operator sees why delivery refused.
    const refusals = guardrailRefusals(db, taskId);
    expect(refusals.length).toBe(1);
    expect(refusals[0].detail).toContain('phase4');
    expect(fakePrProvider.createdPrs.length).toBe(0);
  });

  it('pr.create REFUSES a task whose only approved review is plan-phase at the tip', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-plan';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    seedReview(db, taskId, 'plan', 'approved', tip, 1);

    await expect(
      handlePrCreate({ db, job: { id: 'j2', kind: 'pr.create', task_id: taskId } as any, payload: { taskId }, signal: new AbortController().signal })
    ).rejects.toThrow(/phase4 code-diff review/);
  });

  it('pr.create REFUSES a stale phase4 approval even with a walkthrough approval AT the tip (the b55e2fda shape)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-stale';
    const { handle } = await seedDeliveryReadyTask(db, taskId);
    // After the phase4-reviewed commit, the branch advances AGAIN (e.g. a
    // verify-failure sendback) and only a walkthrough approval exists at the
    // new tip — the exact b55e2fda / N1(b) scar shape.
    const reviewedTip = git(['rev-parse', 'HEAD'], handle.path);
    fs.writeFileSync(path.join(handle.path, 'sendback.txt'), 'test-only fix\n');
    git(['add', '-A'], handle.path);
    git(['commit', '-m', 'sendback: test-only fix'], handle.path);
    const newTip = git(['rev-parse', 'HEAD'], handle.path);

    seedReview(db, taskId, 'phase4', 'approved', reviewedTip, 1); // stale: below the tip
    seedReview(db, taskId, 'walkthrough', 'approved', newTip, 2); // at the tip, wrong phase

    await expect(
      handlePrCreate({ db, job: { id: 'j3', kind: 'pr.create', task_id: taskId } as any, payload: { taskId }, signal: new AbortController().signal })
    ).rejects.toThrow(/does not match current branch tip/);
  });

  it('pr.create REFUSES a REVISED phase4 review (verdict must be approved)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-revise';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    seedReview(db, taskId, 'phase4', 'amend', tip, 1);

    await expect(
      handlePrCreate({ db, job: { id: 'j4', kind: 'pr.create', task_id: taskId } as any, payload: { taskId }, signal: new AbortController().signal })
    ).rejects.toThrow(/phase4 code-diff review/);
  });

  // --- pr.create: the allow path ---

  it('pr.create ALLOWS a task with an approved phase4 review at the tip', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-allow';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    seedReview(db, taskId, 'phase4', 'approved', tip, 1);

    await handlePrCreate({
      db,
      job: { id: 'j5', kind: 'pr.create', task_id: taskId } as any,
      payload: { taskId },
      signal: new AbortController().signal
    });

    expect(fakePrProvider.createdPrs.length).toBe(1);
    expect(fakePrProvider.createdPrs[0].branch).toBe(`bureau-wt-${taskId}`);
  });

  it('pr.create ALLOWS a standing phase4 approval at the tip even when a LATER walkthrough row exists at the same tip (same tree, flow rows do not invalidate the diff review)', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-both';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    seedReview(db, taskId, 'phase4', 'approved', tip, 1);
    seedReview(db, taskId, 'walkthrough', 'approved', tip, 2); // later row, same commit

    await handlePrCreate({
      db,
      job: { id: 'j6', kind: 'pr.create', task_id: taskId } as any,
      payload: { taskId },
      signal: new AbortController().signal
    });

    expect(fakePrProvider.createdPrs.length).toBe(1);
  });

  // --- pr.merge mirrors the same gate ---

  it('pr.merge REFUSES a walkthrough-only approval at the tip', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-merge-refuse';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    db.run('UPDATE bureau_tasks SET pull_request_url = ? WHERE id = ?',
      `https://github.com/org/repo/pull/99`, taskId);
    seedReview(db, taskId, 'walkthrough', 'approved', tip, 1);

    await expect(
      handlePrMerge({ db, job: { id: 'j7', kind: 'pr.merge', task_id: taskId } as any, payload: { taskId, prNumber: 99 }, signal: new AbortController().signal })
    ).rejects.toThrow(/phase4 code-diff review/);

    const refusals = guardrailRefusals(db, taskId);
    expect(refusals.length).toBe(1);
  });

  it('pr.merge ALLOWS an approved phase4 review at the tip', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'task-n2-merge-allow';
    const { tip } = await seedDeliveryReadyTask(db, taskId);
    seedReview(db, taskId, 'phase4', 'approved', tip, 1);

    await handlePrMerge({
      db,
      job: { id: 'j8', kind: 'pr.merge', task_id: taskId } as any,
      payload: { taskId, prNumber: 1 },
      signal: new AbortController().signal
    });

    expect(fakePrProvider.mergedPrs.length).toBe(1);
  });
});
