import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { reconcileDeliveries, DELIVERY_RESUME_BUDGET } from '../../engine/flow/reconcile_deliveries.ts';
import { journal } from '../../engine/journal/writer.ts';

/**
 * reconcileDeliveries — restart-safe delivery resumption. An approved task whose
 * delivery job DIED is otherwise stuck forever (dead = terminal). This re-drives
 * the correct next step, bounded + classified, never transitioning state.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('tc: reconcileDeliveries (restart-safe delivery resume)', () => {
  let tempDir: string;
  let originPath: string;
  let seedPath: string;
  let repoPath: string;
  let dbPath: string;
  let wsp: GitWorkspaceProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-tc-resume-'));
    originPath = path.join(tempDir, 'origin.git');
    seedPath = path.join(tempDir, 'seed');
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    execFileSync('git', ['init', '--bare', originPath]);
    fs.mkdirSync(seedPath, { recursive: true });
    git(seedPath, ['init']);
    git(seedPath, ['config', 'user.name', 'T']);
    git(seedPath, ['config', 'user.email', 't@e.com']);
    fs.writeFileSync(path.join(seedPath, 'README.md'), '# Seed');
    git(seedPath, ['add', 'README.md']);
    git(seedPath, ['commit', '-m', 'init']);
    git(seedPath, ['branch', '-M', 'main']);
    git(seedPath, ['remote', 'add', 'origin', originPath]);
    git(seedPath, ['push', '-u', 'origin', 'main']);
    execFileSync('git', ['clone', '--branch', 'main', originPath, repoPath]);
    git(repoPath, ['config', 'user.name', 'T']);
    git(repoPath, ['config', 'user.email', 't@e.com']);
    git(repoPath, ['config', 'core.autocrlf', 'false']);

    wsp = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(wsp);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedApproved(db: any, taskId: string, opts?: { pr?: string; state?: string }) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, approved_at, approved_by, pull_request_url, work_uuid, created_at, updated_at)
       VALUES (?, 'T', 'i', ?, 0, ?, 'human-operator:admin', ?, 'wu', ?, ?)`,
      taskId, opts?.state ?? 'needs-review', now, opts?.pr ?? null, now, now
    );
  }
  async function worktree(db: any, taskId: string): Promise<string> {
    const h = await wsp.prepare(db, taskId);
    return h.path;
  }
  function addPhase4(db: any, taskId: string, verdict: string, reviewedCommit: string | null) {
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES (?, ?, 'wu', 'phase4', 1, ?, 'c', ?, 'senior-engineer', 'claude', 'm', NULL, ?)`,
      `rv-${taskId}-${Math.random()}`, taskId, verdict, reviewedCommit, new Date().toISOString()
    );
  }
  function addDeadJob(db: any, taskId: string, kind: string, error: string) {
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, run_after, attempts, max_attempts, reaped_count, created_at, finished_at, last_error)
       VALUES (?, ?, ?, '{}', 'dead', NULL, 3, 3, 0, ?, ?, ?)`,
      `job-${taskId}-${Math.random()}`, kind, taskId, new Date().toISOString(), new Date().toISOString(), error
    );
  }
  function liveJobs(db: any, taskId: string, kind: string): number {
    return db.get(`SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = ? AND kind = ? AND state = 'pending'`, taskId, kind).n;
  }
  function parkSpan(db: any, taskId: string, action: string): any {
    return db.all(`SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'`, taskId)
      .map((r: any) => JSON.parse(r.detail)).find((d: any) => d.action === action);
  }

  it('no gate at tip: enqueues work.diff-review to produce the phase4 gate', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-nogate');
    await worktree(db, 'r-nogate');
    const acted = reconcileDeliveries(db);
    expect(acted).toContain('r-nogate');
    expect(liveJobs(db, 'r-nogate', 'work.diff-review')).toBe(1);
  });

  it('gate at tip + open PR: enqueues pr.merge', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-merge', { pr: 'https://github.com/o/r/pull/5' });
    const wt = await worktree(db, 'r-merge');
    addPhase4(db, 'r-merge', 'approved', git(wt, ['rev-parse', 'HEAD']));
    reconcileDeliveries(db);
    expect(liveJobs(db, 'r-merge', 'pr.merge')).toBe(1);
  });

  it('gate at tip + no PR: enqueues pr.create', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-create');
    const wt = await worktree(db, 'r-create');
    addPhase4(db, 'r-create', 'approved', git(wt, ['rev-parse', 'HEAD']));
    reconcileDeliveries(db);
    expect(liveJobs(db, 'r-create', 'pr.create')).toBe(1);
  });

  it('PR + pr.merge dead "not mergeable": enqueues delivery.freshen (the conflict corpse)', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-freshen', { pr: 'https://github.com/o/r/pull/9' });
    await worktree(db, 'r-freshen');
    addDeadJob(db, 'r-freshen', 'pr.merge', 'PR 9 is not mergeable: the merge commit cannot be cleanly created.');
    reconcileDeliveries(db);
    expect(liveJobs(db, 'r-freshen', 'delivery.freshen')).toBe(1);
  });

  it('latest diff-review AMEND: excluded (owes a junior fix, not delivery)', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-amend');
    const wt = await worktree(db, 'r-amend');
    addPhase4(db, 'r-amend', 'amend', git(wt, ['rev-parse', 'HEAD']));
    const acted = reconcileDeliveries(db);
    expect(acted).not.toContain('r-amend');
    expect(liveJobs(db, 'r-amend', 'work.diff-review')).toBe(0);
  });

  it('hard (non-transient) delivery error: parks once, does NOT auto-retry', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-hard');
    await worktree(db, 'r-hard');
    addDeadJob(db, 'r-hard', 'pr.create', "Command 'gh pr create' failed: branch not found");
    const acted = reconcileDeliveries(db);
    expect(acted).not.toContain('r-hard');
    expect(parkSpan(db, 'r-hard', 'delivery_resume_hard_error')).toBeDefined();
    expect(liveJobs(db, 'r-hard', 'pr.create')).toBe(0);
    // Second sweep does not double-journal (parked once).
    reconcileDeliveries(db);
    const spans = db.all(`SELECT detail FROM bureau_journal WHERE task_id = 'r-hard' AND kind = 'guardrail'`)
      .map((r: any) => JSON.parse(r.detail)).filter((d: any) => d.action === 'delivery_resume_hard_error');
    expect(spans).toHaveLength(1);
  });

  it('not approved / live delivery job: not a candidate', async () => {
    const db = openDbConnection(dbPath);
    // not approved
    const now = new Date().toISOString();
    db.run(`INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, work_uuid, created_at, updated_at)
            VALUES ('r-unappr','T','i','needs-review',0,'wu',?,?)`, now, now);
    await worktree(db, 'r-unappr');
    // approved but a live pr.merge already pending
    seedApproved(db, 'r-live', { pr: 'https://github.com/o/r/pull/1' });
    await worktree(db, 'r-live');
    db.run(`INSERT INTO bureau_jobs (id,kind,task_id,payload,state,run_after,attempts,max_attempts,reaped_count,created_at)
            VALUES ('lj','pr.merge','r-live','{}','pending',NULL,0,3,0,?)`, now);
    const acted = reconcileDeliveries(db);
    expect(acted).not.toContain('r-unappr');
    expect(acted).not.toContain('r-live');
  });

  it('budget: after DELIVERY_RESUME_BUDGET resumes, parks (no more auto-resume)', async () => {
    const db = openDbConnection(dbPath);
    seedApproved(db, 'r-budget');
    await worktree(db, 'r-budget');
    for (let i = 0; i < DELIVERY_RESUME_BUDGET; i++) {
      journal(db, {
        kind: 'system',
        attribution: { actor_role: 'system', provider: 'deterministic', model: 'core', account: null },
        taskId: 'r-budget',
        detail: { action: 'delivery_resume', next: 'work.diff-review' }
      });
    }
    const acted = reconcileDeliveries(db);
    expect(acted).not.toContain('r-budget');
    expect(parkSpan(db, 'r-budget', 'delivery_resume_exhausted')).toBeDefined();
  });
});
