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
