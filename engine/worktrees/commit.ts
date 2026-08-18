import { execSync } from 'node:child_process';
import type { DbConnection } from '../contract/types.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';

/**
 * Returns the exact git commit hash (HEAD) of the task's worktree branch.
 * Module-level helper used by Stream A (work review) and Stream B (merge verification).
 */
export async function getBranchTipCommit(db: DbConnection, taskId: string): Promise<string> {
  const provider = getWorkspaceProvider();
  const handle = await provider.getWorkspaceHandle(db, taskId);
  if (!handle || !handle.path) {
    throw new Error(`Worktree for task ${taskId} not found`);
  }

  try {
    const tip = execSync('git rev-parse HEAD', {
      cwd: handle.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (!tip) {
      throw new Error(`git rev-parse HEAD returned empty output in ${handle.path}`);
    }

    return tip;
  } catch (err: any) {
    throw new Error(`Failed to read branch tip commit for task ${taskId}: ${err.message}`);
  }
}
