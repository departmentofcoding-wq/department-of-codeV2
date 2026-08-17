import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { DbConnection, AttributionTuple } from '../contract/index.ts';
import { formatActor } from '../contract/validation.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';

export async function checkpoint(
  db: DbConnection,
  taskId: string,
  attribution: AttributionTuple,
  note?: string
): Promise<void> {
  const provider = getWorkspaceProvider();
  const handle = await provider.getWorkspaceHandle(db, taskId);

  if (!fs.existsSync(handle.path)) {
    return;
  }

  const clean = await provider.isClean(db, taskId);
  if (clean) {
    return;
  }

  execFileSync('git', ['add', '-A'], {
    cwd: handle.path,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const cleanAfterAdd = execFileSync('git', ['status', '--porcelain'], {
    cwd: handle.path,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim() === '';

  if (cleanAfterAdd) {
    return;
  }

  const message = `bureau-checkpoint: ${taskId}${note ? ' ' + note : ''}\n\nAttribution: ${formatActor(attribution)}`;

  execFileSync('git', ['commit', '-m', message], {
    cwd: handle.path,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const now = new Date().toISOString();
  db.run(
    'UPDATE bureau_worktrees SET updated_at = ? WHERE task_id = ?',
    now,
    taskId
  );
}
