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

  // Stage everything EXCEPT junior artifacts. `git add -A` swept
  // docs/junior-artifacts/** onto delivery branches too (2026-09-06: branch
  // bureau-wt-05c6edc0 carried artifacts belonging to OTHER dispatch ids),
  // where they are pure conflict ballast between sibling tasks.
  //
  // We must keep artifacts out of the commit in BOTH the dept repo (where
  // docs/junior-artifacts is .gitignored) and non-dept project repos (which do
  // not inherit this repo's ignore file). A single
  // `git add -A -- :(exclude)docs/junior-artifacts` naming the path fails hard
  // when it is ALSO gitignored — git errors "The following paths are ignored …
  // Use -f" and exits non-zero, so EVERY checkpoint in the dept repo threw and
  // no task could ever deliver (2026-09-09). Instead: stage everything (add -A
  // silently skips gitignored artifacts; in a non-dept repo it stages them),
  // then unstage the artifact path (a no-op when nothing there was staged).
  // Never names the ignored path to `add`. Artifacts stay on disk for seniors;
  // existing tracked artifact files are left as HEAD has them.
  execFileSync('git', ['add', '-A'], {
    cwd: handle.path,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  execFileSync('git', ['reset', '-q', '--', 'docs/junior-artifacts'], {
    cwd: handle.path,
    encoding: 'utf-8',
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
