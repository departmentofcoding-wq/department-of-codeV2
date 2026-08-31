import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import * as backupSeam from '../../engine/contract/backup-seam.ts';
import { getBackupProvider, setBackupProviderOverride } from '../../engine/contract/backup-seam.ts';
import { ExecGitBackupProvider } from '../../engine/durability/git_backup_provider.ts';
import { handleBackupPush } from '../../engine/durability/backup_push.ts';

/**
 * N9: backup.push must run against the TASK'S OWN project repo, not the dept
 * repo. `pr.merge` enqueues a backup.push after EVERY merge (non-dept tasks
 * included); before this fix every git command ran in the dept repo, so the
 * containment-check/push read the wrong remote for a non-dept project (the same
 * class of bug as N8, one layer down).
 */
describe('N9: backup.push targets the task\'s project repo', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    setBackupProviderOverride(null);
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  it('seam: getBackupProvider(repoRoot) roots the provider there; default is the dept tree', () => {
    const rooted = getBackupProvider('/some/project/repo') as ExecGitBackupProvider;
    expect(rooted.repoRoot).toBe('/some/project/repo');

    const dflt = getBackupProvider() as ExecGitBackupProvider;
    // Defaults to the engine source tree root (…/engine/contract → repo root),
    // which ends with neither 'engine' nor 'contract'.
    expect(dflt.repoRoot).not.toContain('project');
    expect(path.basename(dflt.repoRoot)).not.toBe('contract');
  });

  it('resolution: a non-dept task roots the backup provider at its project repo', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n9-'));
    const bare = path.join(tempDir, 'remote.git');
    const projectRepo = path.join(tempDir, 'project');
    const dbPath = path.join(tempDir, 'test.db');

    // A real project repo wired to a real bare remote, with a commit pushed —
    // so remoteContains(commit) is TRUE only when git runs in THIS repo.
    fs.mkdirSync(bare, { recursive: true });
    git(['init', '--bare'], bare);
    fs.mkdirSync(projectRepo, { recursive: true });
    git(['init'], projectRepo);
    git(['config', 'user.name', 'Bureau'], projectRepo);
    git(['config', 'user.email', 'bureau@local'], projectRepo);
    fs.writeFileSync(path.join(projectRepo, 'a.txt'), 'one\n');
    git(['add', '-A'], projectRepo);
    git(['commit', '-m', 'project work'], projectRepo);
    git(['branch', '-M', 'main'], projectRepo);
    git(['remote', 'add', 'origin', bare], projectRepo);
    git(['push', 'origin', 'main'], projectRepo);
    const mergeCommit = git(['rev-parse', 'HEAD'], projectRepo);

    const db: DbConnection = openDbConnection(dbPath);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_projects (id, name, path_to_repo, created_at, updated_at)
       VALUES ('proj-n9', 'N9 Project', ?, ?, ?)`,
      projectRepo, now, now
    );
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, project_id, work_uuid, created_at, updated_at)
       VALUES ('task-n9', 'N9 task', 'queued', 'proj-n9', 'wuuid-n9', ?, ?)`,
      now, now
    );

    // Spy the seam so the test can (a) ASSERT which repoRoot handleBackupPush
    // resolved, and (b) stay SAFE — the spy ALWAYS returns a provider rooted at
    // the temp project repo, so even if the resolution regressed to `undefined`
    // the flow could never run destructive git (push!) against the live dept
    // repo. This is deliberately not the real getBackupProvider(undefined) path.
    let seenRepoRoot: string | undefined = 'UNCALLED';
    const spy = vi.spyOn(backupSeam, 'getBackupProvider').mockImplementation((repoRoot?: string) => {
      seenRepoRoot = repoRoot;
      return new ExecGitBackupProvider(projectRepo);
    });

    try {
      const ctx = {
        db,
        job: { id: 'job-n9', task_id: 'task-n9', kind: 'backup.push' },
        payload: { target: 'origin/main', commit: mergeCommit }
      } as any;

      await handleBackupPush(ctx);
    } finally {
      spy.mockRestore();
    }

    // The provider was rooted at the task's project repo — NOT the dept repo,
    // NOT undefined (which would default to the dept tree).
    expect(seenRepoRoot).toBe(projectRepo);

    // And end-to-end it operated on that repo: the commit is on the project's
    // remote, so containment was proven there.
    const spans = db.all<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE task_id = 'task-n9' AND detail LIKE '%already_on_remote%'"
    );
    expect(spans.length).toBe(1);
    expect(spans[0].detail).toContain(mergeCommit);
  });
});
