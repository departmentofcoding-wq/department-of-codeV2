import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { DbConnection, BureauWorktreeRow } from '../contract/index.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';

export async function pruneWorktree(db: DbConnection, taskId: string): Promise<void> {
  const provider = getWorkspaceProvider();
  const row = db.get<BureauWorktreeRow>(
    "SELECT * FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
    taskId
  );

  if (!row) {
    return;
  }

  if (row.status !== 'ready') {
    throw new Error(`Refusing to prune worktree for task ${taskId}: status is '${row.status}' (must be 'ready')`);
  }

  const clean = await provider.isClean(db, taskId);
  if (!clean) {
    throw new Error(`Refusing to prune worktree for task ${taskId}: worktree at ${row.path} is dirty`);
  }

  if (fs.existsSync(row.path)) {
    try {
      execFileSync('git', ['worktree', 'remove', row.path], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      // Force remove if clean git worktree remove needs force
      try {
        execFileSync('git', ['worktree', 'remove', '--force', row.path], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch {
        fs.rmSync(row.path, { recursive: true, force: true });
      }
    }
  }

  const now = new Date().toISOString();
  db.run(
    "UPDATE bureau_worktrees SET status = 'removed', updated_at = ? WHERE id = ?",
    now,
    row.id
  );
}

/**
 * Bounded retry for post-merge pruning (the 2026-08-28 EPERM scar: the junior
 * IDE still held the worktree directory when pr.merge tried to prune it, so
 * `git worktree remove` / rmSync hit EPERM and the directory was abandoned
 * with only a warn span — accumulating stale worktrees at exactly the rate
 * Phase 8 plans to multiply). One immediate attempt, then one try after each
 * delay in `delaysMs`. The final error propagates to the caller (which
 * journals the deferral); a transient failure that clears is silent success.
 *
 * Pure and injectable: tests pass a fake prune + a fake sleep so nothing
 * wall-clocks.
 */
export async function pruneWithRetry(
  prune: () => Promise<void>,
  delaysMs: readonly number[] = [2000, 10000],
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<{ ok: boolean; attempts: number; lastError?: string }> {
  let attempts = 0;
  let lastError: string | undefined;
  for (const delay of [0, ...delaysMs]) {
    if (delay > 0) await sleep(delay);
    attempts++;
    try {
      await prune();
      return { ok: true, attempts };
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
  }
  return { ok: false, attempts, lastError };
}
