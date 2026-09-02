import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { mergeAllowed } from '../../engine/delivery/merge_guard.ts';
import { decideHookOutcome, decideRefUpdate, type HookInputs, type RefUpdateInput } from '../../scripts/merge_guard_hook.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

/**
 * tc_merge_guard — the merge law as a machine-checkable predicate.
 *
 * Proves that `mergeAllowed` blesses a commit ONLY when a Senior-approved work
 * review names it as `reviewed_commit` AND the owning task reached the done-gate
 * (state=done, merged_at set). Everything else — a forged/unknown commit, an
 * un-approved review, a task still in flight, an empty hash — is refused. This
 * is the structural guard against the 2026-08-24 out-of-band-merge scar.
 */
describe('tc_merge_guard: the merge law as a predicate', () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  const BLESSED = 'a'.repeat(40);
  const FORGED = 'b'.repeat(40);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-tc-mergeguard-'));
    dbPath = path.join(tempDir, 'test.db');
    db = openDbConnection(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedTask(taskId: string, opts: { state: string; merged?: boolean }) {
    const now = new Date().toISOString();
    // Reaching done legitimately requires verifier_exit_code 0 + approval columns
    // (the done-gate CHECK); seed those so a 'done' row is insertable.
    const approvedAt = opts.state === 'done' ? now : null;
    const approvedBy = opts.state === 'done' ? 'human-operator:admin' : null;
    const exitCode = opts.state === 'done' ? 0 : null;
    const mergedAt = opts.merged ? now : null;
    const mergedBy = opts.merged ? 'system' : null;
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, approved_at, approved_by, merged_at, merged_by, work_uuid, created_at, updated_at)
       VALUES (?, 'Guard Task', 'intent', ?, ?, ?, ?, ?, ?, 'work-uuid', ?, ?)`,
      taskId, opts.state, exitCode, approvedAt, approvedBy, mergedAt, mergedBy, now, now
    );
  }

  function seedReview(taskId: string, verdict: string, reviewedCommit: string | null, phase = 'phase4') {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
       VALUES (?, ?, 'work-uuid', ?, 1, ?, ?, 'senior-engineer', 'zai', 'glm-5.2', ?)`,
      `wr-${Math.random()}`, taskId, phase, verdict, reviewedCommit, now
    );
  }

  it('allows a commit approved by a senior AND delivered through the tracked path', () => {
    seedTask('task-1', { state: 'done', merged: true });
    seedReview('task-1', 'approved', BLESSED);

    const result = mergeAllowed(db, BLESSED);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('task-1');
  });

  it('N2: refuses a commit whose only approval is walkthrough-phase (not diff-verified)', () => {
    seedTask('task-wt-only', { state: 'done', merged: true });
    seedReview('task-wt-only', 'approved', BLESSED, 'walkthrough');

    const result = mergeAllowed(db, BLESSED);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no Senior-approved work review');
  });

  it('refuses a forged commit with no work review at all (the out-of-band scar)', () => {
    seedTask('task-1', { state: 'done', merged: true });
    seedReview('task-1', 'approved', BLESSED);

    const result = mergeAllowed(db, FORGED);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no Senior-approved work review');
  });

  it('refuses a commit whose only review is a REVISE verdict', () => {
    seedTask('task-1', { state: 'needs-review' });
    seedReview('task-1', 'amend', BLESSED);

    const result = mergeAllowed(db, BLESSED);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no Senior-approved work review');
  });

  it('refuses an approved commit whose task has NOT reached the done-gate yet', () => {
    // Senior approved the walkthrough, but delivery (pr.merge) has not run —
    // merging it by hand now would bypass verify + operator approval.
    seedTask('task-1', { state: 'needs-review' });
    seedReview('task-1', 'approved', BLESSED);

    const result = mergeAllowed(db, BLESSED);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not completed the tracked delivery path');
  });

  it('refuses an empty commit hash', () => {
    const result = mergeAllowed(db, '   ');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no commit hash');
  });
});

/**
 * The git-hook decision layer — how the predicate is applied given the git
 * context (which branch, plain commit vs merge, operator override). Pure and
 * injectable, so no git is spawned here.
 */
describe('decideHookOutcome: git-hook enforcement of the merge law', () => {
  const bless = (allowed: boolean) => () => ({ allowed, reason: allowed ? 'blessed' : 'not blessed' });
  const base: HookInputs = {
    branch: 'main',
    protectedBranch: 'main',
    mergeTip: 'c'.repeat(40),
    isPlainCommit: false,
    allowOverride: false
  };

  it('never interferes off the protected branch (stream branches)', () => {
    const d = decideHookOutcome({ ...base, branch: 'wt/some-stream' }, bless(false));
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('allow');
  });

  it('refuses a plain hand-commit directly on main', () => {
    const d = decideHookOutcome({ ...base, isPlainCommit: true, mergeTip: null }, bless(true));
    expect(d.exitCode).toBe(1);
    expect(d.outcome).toBe('refuse');
    expect(d.reason).toContain('direct commit to main');
  });

  it('refuses a merge of an unblessed tip into main', () => {
    const d = decideHookOutcome(base, bless(false));
    expect(d.exitCode).toBe(1);
    expect(d.outcome).toBe('refuse');
  });

  it('allows a merge of a blessed tip into main', () => {
    const d = decideHookOutcome(base, bless(true));
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('allow');
  });

  it('honors the operator override, recording it as an override (not a silent allow)', () => {
    const d = decideHookOutcome({ ...base, allowOverride: true }, bless(false));
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('override');
  });
});

/**
 * The reference-transaction layer — the backstop that catches FAST-FORWARD
 * advances of the protected branch (which create no commit, so pre-*-commit
 * never fire). Must refuse an unblessed ff/reset while still allowing a
 * `git pull` of already-delivered remote history.
 */
describe('decideRefUpdate: fast-forward / ref-update enforcement', () => {
  const bless = (allowed: boolean) => () => ({ allowed, reason: allowed ? 'blessed' : 'not blessed' });
  const ZERO = '0'.repeat(40);
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  const base: RefUpdateInput = { ref: 'refs/heads/main', oldValue: OLD, newValue: NEW, protectedRef: 'refs/heads/main', allowOverride: false };

  it('ignores updates to non-protected refs (stream branches, remote-tracking)', () => {
    const d = decideRefUpdate({ ...base, ref: 'refs/heads/wt/x' }, bless(false), () => false);
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('allow');
  });

  it('allows branch creation (old = zero) and deletion (new = zero)', () => {
    expect(decideRefUpdate({ ...base, oldValue: ZERO }, bless(false), () => false).exitCode).toBe(0);
    expect(decideRefUpdate({ ...base, newValue: ZERO }, bless(false), () => false).exitCode).toBe(0);
  });

  it('REFUSES a fast-forward of main to an unblessed tip not on the remote (the ff bypass)', () => {
    const d = decideRefUpdate(base, bless(false), () => false);
    expect(d.exitCode).toBe(1);
    expect(d.outcome).toBe('refuse');
  });

  it('allows a pull: the new tip is already on origin/main (delivered history)', () => {
    const d = decideRefUpdate(base, bless(false), () => true);
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('allow');
    expect(d.reason).toContain('already on the remote');
  });

  it('allows a blessed tip even if not yet on the remote', () => {
    const d = decideRefUpdate(base, bless(true), () => false);
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('allow');
  });

  it('honors the operator override on a ref update', () => {
    const d = decideRefUpdate({ ...base, allowOverride: true }, bless(false), () => false);
    expect(d.exitCode).toBe(0);
    expect(d.outcome).toBe('override');
  });
});
