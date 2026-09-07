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
 * instance lock (inner) — one consistent order, no deadlock. A live holder past
 * the wait window fails fast ("senior busy"); the delivery review job is
 * retryable, so it simply runs on a later tick rather than colliding now.
 */
export function defaultSeniorReviewLockPath(): string {
  return process.env['SENIOR_REVIEW_LOCK_PATH'] || path.join(os.tmpdir(), 'dept-of-code-senior-review.lock');
}

/** How long to wait for an in-flight review to finish before failing (retryable). */
export const SENIOR_REVIEW_LOCK_DEFAULT_WAIT_MS = 4 * 60 * 1000;

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
