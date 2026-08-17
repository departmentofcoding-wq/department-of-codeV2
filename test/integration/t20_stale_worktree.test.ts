import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { setWorkspaceProvider, type BureauWorktreeRow } from '../../engine/contract/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

describe('T20: Stale Worktree Status on Moved Main Branch', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;

  function runGit(args: string[], cwd: string = repoPath): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t20-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(repoPath, { recursive: true });
    runGit(['init'], repoPath);
    runGit(['config', 'user.name', 'Test Runner'], repoPath);
    runGit(['config', 'user.email', 'test@bureau.local'], repoPath);

    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Stale Test Repo\n');
    runGit(['add', '.'], repoPath);
    runGit(['commit', '-m', 'Initial commit'], repoPath);
    runGit(['branch', '-M', 'main'], repoPath);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'ignore' });
      } catch {}
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('T20: a moved main records status=stale with the original base_commit preserved', async () => {
    const db = openDbConnection(dbPath);
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    const taskId = 't20-stale';
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at) VALUES (?, 'T20 Task', 'queued', 'w-t20', ?, ?)",
      taskId,
      now,
      now
    );

    // 1. Initial prepare creates worktree at initial main base commit
    const handle1 = await provider.prepare(db, taskId);
    const initialBase = handle1.baseCommit;

    const row1 = db.get<BureauWorktreeRow>("SELECT * FROM bureau_worktrees WHERE task_id = ?", taskId);
    expect(row1?.status).toBe('ready');
    expect(row1?.base_commit).toBe(initialBase);

    // 2. Advance main branch with a new commit
    fs.writeFileSync(path.join(repoPath, 'main_update.txt'), 'main update\n');
    runGit(['add', '.'], repoPath);
    runGit(['commit', '-m', 'Main commit 2'], repoPath);

    const newMainTip = runGit(['rev-parse', 'main'], repoPath);
    expect(newMainTip).not.toBe(initialBase);

    // 3. Prepare on clean worktree again -> detects main moved, marks status='stale', keeps original base_commit
    const handle2 = await provider.prepare(db, taskId);
    expect(handle2.baseCommit).toBe(initialBase); // original base preserved

    const row2 = db.get<BureauWorktreeRow>("SELECT * FROM bureau_worktrees WHERE task_id = ?", taskId);
    expect(row2?.status).toBe('stale');
    expect(row2?.base_commit).toBe(initialBase);
  });
});
