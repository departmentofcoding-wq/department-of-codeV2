import { execSync } from 'node:child_process';
import type { DbConnection } from '../contract/types.ts';

/**
 * Returns the exact git commit hash (HEAD) of the task's worktree branch.
 * Module-level helper used by Stream A (work review) and Stream B (merge verification).
 * Reads the worktree path from bureau_worktrees directly (provider-free).
 */
export async function getBranchTipCommit(db: DbConnection, taskId: string): Promise<string> {
  const row = db.get<{ path: string }>(
    "SELECT path FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
    taskId
  );
  if (!row || !row.path) {
    throw new Error(`Worktree for task ${taskId} not found`);
  }

  try {
    const tip = execSync('git rev-parse HEAD', {
      cwd: row.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (!tip) {
      throw new Error(`git rev-parse HEAD returned empty output in ${row.path}`);
    }

    return tip;
  } catch (err: any) {
    throw new Error(`Failed to read branch tip commit for task ${taskId}: ${err.message}`);
  }
}
