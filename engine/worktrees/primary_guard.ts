import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * N16 — the primary-checkout contamination guard.
 *
 * Scar (2026-09-01, task 0e921cfa/N11): a junior implementation dispatch wrote
 * ~284 lines of uncommitted edits into the PRIMARY checkout (tracked engine
 * files) in addition to its worktree work — a fresh process loading the main
 * tree would have run unreviewed junior code. The operator had to stash it off
 * main by hand. The dispatch window is pointed at the worktree
 * (`requireFolder` + a dedicated folder window), but nothing VERIFIED the
 * primary tree stayed clean; an agent that resolves a file against its other
 * open workspace (or by absolute path) leaks silently.
 *
 * This guard is that verification: after a delivery dispatch, the primary
 * repo's TRACKED files must be untouched. Deliberately tracked-only
 * (`--untracked-files=no`): untracked files are not the leak class (the
 * incident modified tracked engine files), and the engine itself writes
 * untracked artifacts (`docs/junior-artifacts/`) plus the operator keeps
 * untracked plan docs — those must never trip the guard.
 */

export class PrimaryTreeContaminatedError extends Error {
  readonly dirtyPaths: string[];
  constructor(dirtyPaths: string[]) {
    super(
      `Primary checkout contaminated by the dispatch: ${dirtyPaths.length} tracked path(s) modified ` +
        `[${dirtyPaths.join(', ')}] — the junior must edit only its .bureau-worktrees/<taskId> worktree. ` +
        `The changes were NOT committed; inspect and stash/discard them before re-driving.`
    );
    this.name = 'PrimaryTreeContaminatedError';
    this.dirtyPaths = dirtyPaths;
  }
}

export interface PrimaryTreeInspection {
  clean: boolean;
  dirtyPaths: string[];
}

/** The primary checkout that owns a bureau worktree: `<repoRoot>/.bureau-worktrees/<taskId>`. */
export function resolvePrimaryRepoRoot(worktreePath: string): string {
  return path.resolve(worktreePath, '..', '..');
}

/**
 * Inspect the primary tree. Tracked-file modifications, staged changes, and
 * deletions are dirt; untracked files are not (see rationale above).
 */
export function inspectPrimaryTree(repoRoot: string): PrimaryTreeInspection {
  const out = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );

  // Per-line trimming only: trimming the whole output would eat the leading
  // status-space of the first line (" M file") and shift every path.
  const dirtyPaths = out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  return { clean: dirtyPaths.length === 0, dirtyPaths };
}

/** Fail loud when the primary tree is dirty — never silently leave junior edits in main. */
export function assertPrimaryTreeClean(repoRoot: string): void {
  const inspection = inspectPrimaryTree(repoRoot);
  if (!inspection.clean) {
    throw new PrimaryTreeContaminatedError(inspection.dirtyPaths);
  }
}
