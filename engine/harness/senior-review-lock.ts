import os from 'node:os';
import path from 'node:path';
import { acquireZCodeLock, type ZCodeLockOptions } from './zcode-lock.ts';

/**
 * Department-wide SENIOR-REVIEW mutex — at most one senior review runs at a time
 * across the whole runner, regardless of which senior (claude CLI or zai/ZCode).
 *
 * Why: a delivery re-review (work.diff-review, enqueued by freshen / the delivery
 * reconciler) drives the SAME senior as a regular task's review. Without this,
 * two reviews can run at once — the N15/N10 contention scar (claude subprocess
 * stall, or a second driver resetting the one ZCode window) and double quota.
 * This lock makes the delivery lane's reviews queue behind regular reviews (and
 * vice versa) instead of colliding. It ALSO serializes an operator's manual
 * senior drive against a runner-driven review (the exact 2026-09-02 N15 scar).
 *
 * It reuses the proven zcode-lock file-mutex primitive at a DISTINCT path, so for
 * zai the acquisition order is always senior-review-lock (outer) → zcode
 * instance lock (inner) — one consistent order, no deadlock.
 *
 * The loser WAITS for the holder to finish rather than dying: the three
 * senior-driving jobs (plan.cycle, work.cycle, work.diff-review) are all
 * `maxAttempts: 1`, so a lock that gave up and threw would kill the second review
 * permanently and strand its task (plan/work cycles have no delivery reconciler
 * to re-drive them). So the wait window is deliberately LONGER than any real
 * review yet below the review job's own 45-min timeout: a normal review (minutes)
 * is always waited out; only a genuinely stuck senior (holding past ~40 min, i.e.
 * about to hit its own timeout anyway) makes the waiter give up — the correct
 * outcome, since a wedged senior should fail, not queue forever.
 */
export function defaultSeniorReviewLockPath(): string {
  return process.env['SENIOR_REVIEW_LOCK_PATH'] || path.join(os.tmpdir(), 'dept-of-code-senior-review.lock');
}

/** How long the loser waits for an in-flight review to finish. Longer than any
 *  real review, below the 45-min review job timeout (see the class docstring). */
export const SENIOR_REVIEW_LOCK_DEFAULT_WAIT_MS = 40 * 60 * 1000;

function resolveWaitMs(): number {
  const n = Number(process.env['SENIOR_REVIEW_LOCK_WAIT_MS']);
  return Number.isFinite(n) && n > 0 ? n : SENIOR_REVIEW_LOCK_DEFAULT_WAIT_MS;
}

/**
 * Run `fn` while holding the department-wide senior-review lock. Releases it in a
 * `finally`, even if `fn` throws. `opts` is injectable for unit tests (clock/pid/
 * sleep/path), mirroring acquireZCodeLock.
 */
export async function withSeniorReviewLock<T>(fn: () => Promise<T>, opts: ZCodeLockOptions = {}): Promise<T> {
  const lock = await acquireZCodeLock({
    lockPath: opts.lockPath ?? defaultSeniorReviewLockPath(),
    waitMs: opts.waitMs ?? resolveWaitMs(),
    ...opts
  });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
