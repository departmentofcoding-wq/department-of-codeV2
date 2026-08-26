import type { DbConnection } from '../contract/types.ts';

export interface MergeGuardResult {
  /** True only when the commit reached `main` through the tracked delivery path. */
  allowed: boolean;
  /** Human-readable reason, surfaced by the git hook on refusal (or approval). */
  reason: string;
}

/**
 * The merge law, as a machine-checkable predicate.
 *
 * A commit may reach `main` ONLY if it went through the department's tracked
 * delivery path: a Senior returned APPROVE on a walkthrough whose
 * `reviewed_commit` is exactly this commit, AND the owning task reached the
 * done-gate (`state = 'done'` with `merged_at` set — the done-gate CHECK has
 * already required verifier exit 0 + operator approval before `merged_at` can
 * be written, so this single condition transitively proves the whole gate).
 *
 * This is the structural replacement for the paused hand-merge discipline
 * (scar: 2026-08-24, two shipped tasks reached `main` by hand and left zero
 * delivery-path evidence in the DB). Before this, the merge law was prose plus
 * review discipline; here it becomes a predicate a git hook enforces.
 *
 * Pure and DB-reading only — no git, no filesystem, no network — so it is
 * unit-testable in isolation and safe to call from inside a git hook process.
 * Branch detection and tip resolution live in the hook script that wraps this;
 * this function only answers "is THIS commit blessed?".
 */
export function mergeAllowed(db: DbConnection, tipCommit: string): MergeGuardResult {
  const commit = (tipCommit || '').trim();
  if (!commit) {
    return { allowed: false, reason: 'no commit hash supplied to the merge guard' };
  }

  const shortCommit = commit.slice(0, 12);

  // 1. A Senior APPROVE verdict bound to EXACTLY this commit. `reviewed_commit`
  //    is recorded by the work-review cycle on walkthrough APPROVE (the branch
  //    tip the senior actually reviewed) and re-checked by pr.create/pr.merge.
  const review = db.get<{ task_id: string }>(
    `SELECT task_id FROM bureau_work_reviews
      WHERE reviewed_commit = ? AND verdict = 'approved'
      ORDER BY created_at DESC LIMIT 1`,
    commit
  );
  if (!review) {
    return {
      allowed: false,
      reason: `commit ${shortCommit} has no Senior-approved work review — out-of-band merge refused (the merge law)`
    };
  }

  // 2. The owning task must have completed the tracked delivery path. Reaching
  //    `done` with `merged_at` set is only possible via pr.merge, which the
  //    done-gate CHECK guards (verifier exit 0 + operator approval).
  const task = db.get<{ id: string; state: string; merged_at: string | null }>(
    'SELECT id, state, merged_at FROM bureau_tasks WHERE id = ?',
    review.task_id
  );
  if (!task) {
    return {
      allowed: false,
      reason: `commit ${shortCommit} names task ${review.task_id}, which no longer exists — merge refused`
    };
  }
  if (task.state !== 'done' || !task.merged_at) {
    return {
      allowed: false,
      reason:
        `commit ${shortCommit} (task ${task.id}) has not completed the tracked delivery path ` +
        `(state=${task.state}, merged_at=${task.merged_at ?? 'null'}) — merge refused`
    };
  }

  return {
    allowed: true,
    reason: `commit ${shortCommit} approved by senior for task ${task.id} and delivered through the tracked path`
  };
}
