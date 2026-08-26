/**
 * merge_guard_hook — the git-level enforcement of the merge law.
 *
 * Installed (by scripts/install_git_hooks.ts) as the repo's `pre-merge-commit`
 * and `pre-commit` hooks. It refuses any hand-merge or hand-commit onto the
 * protected branch (`main`) whose introduced tip is NOT blessed by the tracked
 * delivery path — the structural fix for the 2026-08-24 out-of-band-merge scar,
 * where two shipped tasks reached `main` by hand and left zero delivery-path
 * evidence in the DB.
 *
 * The blessing decision is the pure `mergeAllowed` predicate
 * (engine/delivery/merge_guard.ts). This file only supplies the git-derived
 * inputs (current branch, whether a merge is in progress, the tip being merged)
 * and journals the outcome. `decideHookOutcome` is factored out pure so it is
 * unit-testable without spawning git.
 *
 * Escape hatch: `BUREAU_ALLOW_MERGE=1` lets the operator bypass the guard in a
 * genuine emergency; the bypass is journaled as a `human` span so it is never
 * silent. The tracked delivery path (pr.merge) merges on the REMOTE via the PR
 * provider, so it never trips this local hook — only manual git does.
 *
 * Known limitation: a fast-forward merge creates no commit and runs no hook.
 * The installer sets `merge.ff = false` on this repo so a manual merge into
 * main always creates a merge commit the hook can inspect.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import type { DbConnection } from '../engine/contract/types.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { journal } from '../engine/journal/writer.ts';
import { mergeAllowed } from '../engine/delivery/merge_guard.ts';

const SYSTEM_ATTRIBUTION = {
  actor_role: 'system' as const,
  provider: 'deterministic',
  model: 'core',
  account: null
};

export interface HookInputs {
  /** Current branch (e.g. 'main'); empty/undefined when detached or unknown. */
  branch: string;
  /** The protected branch the merge law defends. */
  protectedBranch: string;
  /** Tip commit of the branch being merged in (MERGE_HEAD), if a merge. */
  mergeTip: string | null;
  /** True when this invocation is a plain commit (pre-commit), not a merge. */
  isPlainCommit: boolean;
  /** Operator emergency override. */
  allowOverride: boolean;
}

export interface HookDecision {
  /** 0 = allow the git operation, 1 = abort it. */
  exitCode: number;
  reason: string;
  /** How to journal this: 'allow' (no span), 'override' (human), 'refuse' (guardrail). */
  outcome: 'allow' | 'override' | 'refuse';
  /** The commit the guard evaluated, for the journal detail. */
  tip: string | null;
}

/**
 * Pure decision: given the git-derived inputs and a blessing predicate, decide
 * whether to allow the operation. No git, no journal — unit-testable.
 */
export function decideHookOutcome(
  inputs: HookInputs,
  isBlessed: (tip: string) => { allowed: boolean; reason: string }
): HookDecision {
  // Only the protected branch is defended; stream branches (wt/*) are exactly
  // where work is meant to happen, so never interfere with them.
  if (!inputs.branch || inputs.branch !== inputs.protectedBranch) {
    return { exitCode: 0, reason: `not on ${inputs.protectedBranch} (on '${inputs.branch || 'detached'}') — merge law not enforced`, outcome: 'allow', tip: null };
  }

  if (inputs.allowOverride) {
    return {
      exitCode: 0,
      reason: `BUREAU_ALLOW_MERGE override — operator bypassed the merge law on ${inputs.protectedBranch}`,
      outcome: 'override',
      tip: inputs.mergeTip
    };
  }

  // A plain hand-commit directly on main is never part of the tracked path.
  if (inputs.isPlainCommit) {
    return {
      exitCode: 1,
      reason: `direct commit to ${inputs.protectedBranch} is refused — work on a stream branch and deliver through the tracked path (or set BUREAU_ALLOW_MERGE=1 to override)`,
      outcome: 'refuse',
      tip: null
    };
  }

  // A merge into main. The tracked delivery path merges on the REMOTE (via the
  // PR provider), so a LOCAL merge into main is always a hand-merge that bypassed
  // the flow. When the incoming tip is resolvable we name it precisely via the
  // blessing predicate; when it is not (some git versions do not expose
  // MERGE_HEAD at pre-merge-commit time), we still refuse — fail-closed — because
  // main must never advance by a manual merge.
  if (!inputs.mergeTip) {
    return {
      exitCode: 1,
      reason:
        `merge into ${inputs.protectedBranch} refused — the tracked delivery path merges on the remote, ` +
        `so a local merge is an out-of-band act (set BUREAU_ALLOW_MERGE=1 to override)`,
      outcome: 'refuse',
      tip: null
    };
  }
  const verdict = isBlessed(inputs.mergeTip);
  return {
    exitCode: verdict.allowed ? 0 : 1,
    reason: verdict.reason,
    outcome: verdict.allowed ? 'allow' : 'refuse',
    tip: inputs.mergeTip
  };
}

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The tip commit being merged, resolved during a merge. Reads the canonical
 * `MERGE_HEAD` file directly (most reliable inside a hook, where the git
 * environment can shadow `git rev-parse MERGE_HEAD`), falling back to rev-parse.
 */
function resolveMergeTip(): string | null {
  const mergeHeadPath = git('rev-parse --git-path MERGE_HEAD');
  if (mergeHeadPath && fs.existsSync(mergeHeadPath)) {
    const first = fs.readFileSync(mergeHeadPath, 'utf8').split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  }
  return git('rev-parse -q --verify MERGE_HEAD') || null;
}

/** Gather the git-derived inputs for the running hook. */
export function collectHookInputs(isPlainCommit: boolean): HookInputs {
  const branch = git('rev-parse --abbrev-ref HEAD') ?? '';
  // MERGE_HEAD exists only while a merge is in progress.
  const mergeTip = resolveMergeTip();
  return {
    branch,
    protectedBranch: process.env.BUREAU_PROTECTED_BRANCH || 'main',
    mergeTip,
    isPlainCommit: isPlainCommit && !mergeTip,
    allowOverride: process.env.BUREAU_ALLOW_MERGE === '1'
  };
}

/** Journal the outcome; refusals and overrides are always recorded. */
function journalOutcome(db: DbConnection, decision: HookDecision, hook: string): void {
  if (decision.outcome === 'allow') return;
  journal(db, {
    kind: decision.outcome === 'override' ? 'human' : 'guardrail',
    attribution: SYSTEM_ATTRIBUTION,
    detail: {
      action: 'merge_guard_hook',
      hook,
      status: decision.outcome === 'override' ? 'override' : 'refused',
      tip: decision.tip,
      reason: decision.reason
    }
  });
}

/**
 * Entry point invoked by the installed hook. `hookName` is 'pre-commit' or
 * 'pre-merge-commit'. Returns the process exit code.
 */
export function runMergeGuardHook(hookName: string): number {
  const inputs = collectHookInputs(hookName === 'pre-commit');

  // Fast path: nothing to enforce off the protected branch — decide before
  // even opening the DB.
  if (!inputs.branch || inputs.branch !== inputs.protectedBranch) {
    return 0;
  }

  let db: DbConnection | null = null;
  let decision: HookDecision;
  try {
    db = openDbConnection(process.env.BUREAU_DB_PATH || 'db/bureau.db');
    const dbRef = db;
    decision = decideHookOutcome(inputs, (tip) => mergeAllowed(dbRef, tip));
    journalOutcome(dbRef, decision, hookName);
  } catch (err: any) {
    // Fail-closed on the protected branch: if the guard cannot consult the DB,
    // it refuses rather than waving work through unverified.
    process.stderr.write(
      `\n[merge-guard] could not evaluate the merge law (${err?.message ?? err}). ` +
        `Refusing to touch ${inputs.protectedBranch} without proof. ` +
        `Set BUREAU_ALLOW_MERGE=1 to override.\n\n`
    );
    return inputs.allowOverride ? 0 : 1;
  }

  if (decision.exitCode !== 0) {
    process.stderr.write(`\n[merge-guard] REFUSED: ${decision.reason}\n\n`);
  } else if (decision.outcome === 'override') {
    process.stderr.write(`\n[merge-guard] ${decision.reason}\n\n`);
  }
  return decision.exitCode;
}

// Invoked directly by the git hook wrapper: `node ... merge_guard_hook.ts <hookName>`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('merge_guard_hook.ts')) {
  const hookName = process.argv[2] || 'pre-merge-commit';
  process.exit(runMergeGuardHook(hookName));
}
