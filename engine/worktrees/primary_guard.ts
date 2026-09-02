import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
 *
 * F1 (2026-09-02, task 693ad95a/N9 rekick): the guard compares against a
 * BASELINE snapshot taken at dispatch start, not against an absolutely clean
 * tree. The first N9 delivery run was falsely failed because the operator's
 * own uncommitted ledger edit (`docs/DEPARTMENT_STATUS.md`) sat tracked-dirty
 * in the primary tree BEFORE the dispatch — the absolute check blamed the
 * junior for it. Pre-existing dirt is now ignored: the dispatch is failed only
 * by paths that are NEWLY dirtied or whose working-tree content CHANGED during
 * the run (per-path blob-oid comparison). A genuine new leak still fails loud
 * (the 0e921cfa scar is preserved by tests).
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
 * Parse `git status --porcelain --untracked-files=no` output into dirty paths.
 * Per-line trimming only: trimming the whole output would eat the leading
 * status-space of the first line (" M file") and shift every path. Rename
 * entries keep their composite `old -> new` form (the path a baseline diff can
 * consistently key on; a rename that appears during a run is new dirt either way).
 */
function parseStatusPaths(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
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
  const dirtyPaths = parseStatusPaths(out);
  return { clean: dirtyPaths.length === 0, dirtyPaths };
}

/**
 * F1 — the pre-dispatch baseline. Same tracked-dirty paths as
 * `inspectPrimaryTree`, plus per-path CONTENT identity (`git hash-object` of
 * the working-tree file) so the post-dispatch diff can distinguish "the
 * operator's pre-existing uncommitted edit, untouched by the run" from "the
 * junior modified this file during the run". Null oid = the path is
 * deleted/absent (deletions and rename composites never resolve to a file).
 */
export interface PrimaryTreeSnapshot {
  repoRoot: string;
  /** tracked-dirty path → working-tree blob oid, or null when deleted/absent. */
  dirty: Record<string, string | null>;
  capturedAt: string;
}

/** Capture the baseline (or after-state) of a primary tree. Throws like
 *  `inspectPrimaryTree` does when git/the repo is unavailable. */
export function snapshotPrimaryTree(repoRoot: string): PrimaryTreeSnapshot {
  const out = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const dirtyPaths = parseStatusPaths(out);
  const dirty: Record<string, string | null> = {};
  const existing = dirtyPaths.filter((p) => fs.existsSync(path.join(repoRoot, p)));
  if (existing.length > 0) {
    // One call for every surviving path: hash-object prints one oid per line,
    // in argument order. (Deleted paths would make the whole call fail, so
    // they are excluded above and recorded as null below.)
    const hashes = execFileSync('git', ['hash-object', '--', ...existing], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
      .trim()
      .split('\n')
      .map((h) => h.trim());
    existing.forEach((p, i) => {
      dirty[p] = hashes[i] ?? null;
    });
  }
  for (const p of dirtyPaths) {
    if (!(p in dirty)) dirty[p] = null;
  }
  return { repoRoot, dirty, capturedAt: new Date().toISOString() };
}

/**
 * F1 — which paths did the dispatch ITSELF dirty? A path is flagged when it is
 * newly dirty after the run (clean before, or absent from the baseline because
 * the baseline's `repoRoot` differs — compared conservatively as all-dirty) or
 * when its working-tree content changed during the run (oid differs). A
 * pre-existing dirty edit the run never touches is NOT flagged (the N9
 * false-positive); a path the run reverted back to clean is likewise not a
 * leak. Pure — unit-tested without git.
 */
export function changedAgainstBaseline(
  before: PrimaryTreeSnapshot,
  after: PrimaryTreeSnapshot
): string[] {
  if (path.resolve(before.repoRoot) !== path.resolve(after.repoRoot)) {
    return Object.keys(after.dirty).sort();
  }
  const changed: string[] = [];
  for (const [p, oid] of Object.entries(after.dirty)) {
    const prev = before.dirty[p];
    if (prev === undefined || prev !== oid) changed.push(p);
  }
  return changed.sort();
}

/** Fail loud when the primary tree is dirty — never silently leave junior edits in main. */
export function assertPrimaryTreeClean(repoRoot: string): void {
  const inspection = inspectPrimaryTree(repoRoot);
  if (!inspection.clean) {
    throw new PrimaryTreeContaminatedError(inspection.dirtyPaths);
  }
}
