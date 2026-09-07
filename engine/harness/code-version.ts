import { execFileSync } from 'node:child_process';

/**
 * Code-version awareness for the runner — the fix for the recurring "stale
 * runner" problem (2026-09-07: a resident runner kept executing Sep-6 code for a
 * day after the fixes merged, because Node never hot-reloads and nothing noticed
 * main had moved; worse, a stale runner would grab a pr.merge and run it WITHOUT
 * the freshen classification, re-creating the zombie-retry bug).
 *
 * A process's "code version" is the git HEAD at the moment it started. We stamp
 * it at boot and periodically compare it to the CURRENT HEAD; a drift means the
 * running executor is stale and should be restarted. This module is the pure,
 * testable core — the runner wires it into its tick and warns/notifies on drift.
 */

/** Best-effort git HEAD sha for the given repo (cwd). Null when git is
 *  unavailable or the dir is not a repo — the caller then simply skips the
 *  freshness check rather than crashing. */
export function getGitHeadSha(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Is the running executor stale? True iff both shas are known AND differ. Pure —
 * an unknown sha (null) is never "stale" (we don't warn on missing git info).
 */
export function isCodeStale(bootSha: string | null, currentSha: string | null): boolean {
  return !!bootSha && !!currentSha && bootSha !== currentSha;
}
