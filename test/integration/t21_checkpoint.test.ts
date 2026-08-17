import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { setWorkspaceProvider, type AttributionTuple } from '../../engine/contract/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { checkpoint } from '../../engine/worktrees/checkpoint.ts';

describe('T21: Worktree Checkpoints with Attribution Trailers', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t21-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(repoPath, { recursive: true });
    runGit(['init'], repoPath);
    runGit(['config', 'user.name', 'Test Runner'], repoPath);
    runGit(['config', 'user.email', 'test@bureau.local'], repoPath);

    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Checkpoint Test Repo\n');
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

  const verifierAttr: AttributionTuple = {
    actor_role: 'verifier',
    provider: 'deterministic',
    model: 'core',
    account: null
  };

  it('T21: checkpoints commit WIP with attribution trailer; clean trees are a no-op', async () => {
    const db = openDbConnection(dbPath);
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    const taskId = 't21-checkpoint';
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at) VALUES (?, 'T21 Task', 'verifying', 'w-t21', ?, ?)",
      taskId,
      now,
      now
    );

    const handle = await provider.prepare(db, taskId);

    // 1. Checkpoint clean tree -> no-op
    const initialCommitCount = runGit(['rev-list', '--count', 'HEAD'], handle.path);
    await checkpoint(db, taskId, verifierAttr, 'clean checkpoint');
    const commitCountAfterClean = runGit(['rev-list', '--count', 'HEAD'], handle.path);
    expect(commitCountAfterClean).toBe(initialCommitCount);

    // 2. Modify file to make worktree dirty
    fs.writeFileSync(path.join(handle.path, 'wip.ts'), 'export const fix = 123;\n');
    expect(await provider.isClean(db, taskId)).toBe(false);

    // 3. Checkpoint dirty tree -> commits with attribution trailer
    await checkpoint(db, taskId, verifierAttr, 'send-back fix 1');
    expect(await provider.isClean(db, taskId)).toBe(true);

    const commitMsg = runGit(['log', '-1', '--pretty=format:%B'], handle.path);
    expect(commitMsg).toContain('bureau-checkpoint: t21-checkpoint send-back fix 1');
    expect(commitMsg).toContain('Attribution: verifier');

    // 4. Second checkpoint on clean tree -> no-op
    const commitCountAfterDirty = runGit(['rev-list', '--count', 'HEAD'], handle.path);
    await checkpoint(db, taskId, verifierAttr, 'no-op check');
    const finalCommitCount = runGit(['rev-list', '--count', 'HEAD'], handle.path);
    expect(finalCommitCount).toBe(commitCountAfterDirty);
  }, 20000);
});
