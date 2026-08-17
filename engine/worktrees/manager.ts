import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { DbConnection, WorkspaceHandle, WorkspaceProvider, AttributionTuple, BureauWorktreeRow } from '../contract/index.ts';

const FOREMAN_ATTRIBUTION: AttributionTuple = {
  actor_role: 'foreman',
  provider: 'deterministic',
  model: 'core',
  account: null
};

export function getRepoRoot(customPath?: string): string {
  if (customPath) {
    return customPath;
  }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return root;
  } catch {
    return process.cwd();
  }
}

export class GitWorkspaceProvider implements WorkspaceProvider {
  public readonly repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = getRepoRoot(repoRoot);
  }

  private runGit(args: string[], cwd?: string): string {
    return execFileSync('git', args, {
      cwd: cwd ?? this.repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  }

  public async isClean(db: DbConnection, taskId: string): Promise<boolean> {
    const handle = await this.getWorkspaceHandle(db, taskId);
    if (!fs.existsSync(handle.path)) {
      return true;
    }
    const output = this.runGit(['status', '--porcelain'], handle.path);
    return output.trim() === '';
  }

  public async checkpoint(
    db: DbConnection,
    taskId: string,
    attribution: AttributionTuple,
    note?: string
  ): Promise<void> {
    const { checkpoint: runCheckpoint } = await import('./checkpoint.ts');
    await runCheckpoint(db, taskId, attribution, note);
  }


  public async getWorkspaceHandle(db: DbConnection, taskId: string): Promise<WorkspaceHandle> {
    const row = db.get<BureauWorktreeRow>(
      "SELECT * FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
      taskId
    );
    if (!row) {
      throw new Error(`No worktree found for task ${taskId}`);
    }
    return {
      taskId: row.task_id,
      path: row.path,
      baseCommit: row.base_commit
    };
  }

  public async prepare(db: DbConnection, taskId: string): Promise<WorkspaceHandle> {
    const targetPath = path.join(this.repoRoot, '.bureau-worktrees', taskId);
    const now = new Date().toISOString();

    const existingRow = db.get<BureauWorktreeRow>(
      'SELECT * FROM bureau_worktrees WHERE task_id = ?',
      taskId
    );

    // 1. Existing row that is not 'removed'
    if (existingRow && existingRow.status !== 'removed') {
      if (fs.existsSync(existingRow.path)) {
        const clean = await this.isClean(db, taskId);
        if (!clean) {
          throw new Error(`Worktree for task ${taskId} is dirty at ${existingRow.path}; refusing to reuse or force-delete`);
        }



        // Check if main branch has moved past base_commit
        let currentMainTip = existingRow.base_commit;
        try {
          currentMainTip = this.runGit(['rev-parse', 'main']);
        } catch {
          // Main branch lookup fallback to HEAD if main branch name differs
          try {
            currentMainTip = this.runGit(['rev-parse', 'HEAD']);
          } catch {
            currentMainTip = existingRow.base_commit;
          }
        }

        if (currentMainTip !== existingRow.base_commit && existingRow.status !== 'stale') {
          db.run(
            "UPDATE bureau_worktrees SET status = 'stale', updated_at = ? WHERE id = ?",
            now,
            existingRow.id
          );
        }

        return {
          taskId: existingRow.task_id,
          path: existingRow.path,
          baseCommit: existingRow.base_commit
        };
      }
    }

    // 2. Unpinned matrix cell (a): Directory exists on disk but missing or removed DB row
    if (fs.existsSync(targetPath)) {
      try {
        const diskHead = this.runGit(['rev-parse', 'HEAD'], targetPath);
        const clean = this.runGit(['status', '--porcelain'], targetPath).trim() === '';
        if (!clean) {
          throw new Error(`Unindexed worktree directory for task ${taskId} at ${targetPath} is dirty; refusing to adopt or delete`);
        }

        const id = existingRow ? existingRow.id : crypto.randomUUID();
        if (existingRow) {
          db.run(
            "UPDATE bureau_worktrees SET status = 'ready', base_commit = ?, path = ?, updated_at = ? WHERE id = ?",
            diskHead,
            targetPath,
            now,
            id
          );
        } else {
          db.run(
            `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model, account)
             VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`,
            id,
            taskId,
            targetPath,
            diskHead,
            now,
            now,
            FOREMAN_ATTRIBUTION.actor_role,
            FOREMAN_ATTRIBUTION.provider,
            FOREMAN_ATTRIBUTION.model,
            FOREMAN_ATTRIBUTION.account
          );
        }

        return {
          taskId,
          path: targetPath,
          baseCommit: diskHead
        };
      } catch (err: any) {
        if (err.message?.includes('refusing')) {
          throw err;
        }
        // Invalid or corrupt directory — safe cleanup
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    }

    // 3. Create fresh git worktree based on main
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    let baseCommit = 'main';
    try {
      baseCommit = this.runGit(['rev-parse', 'main']);
    } catch {
      baseCommit = this.runGit(['rev-parse', 'HEAD']);
    }

    const branchName = `bureau-wt-${taskId}`;
    // Delete existing branch if it leftover from a failed run
    try {
      this.runGit(['branch', '-D', branchName]);
    } catch {
      // Ignore if branch doesn't exist
    }

    this.runGit(['worktree', 'add', targetPath, '-b', branchName, 'main']);

    const id = existingRow ? existingRow.id : crypto.randomUUID();
    if (existingRow) {
      db.run(
        "UPDATE bureau_worktrees SET status = 'ready', base_commit = ?, path = ?, updated_at = ? WHERE id = ?",
        baseCommit,
        targetPath,
        now,
        id
      );
    } else {
      db.run(
        `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model, account)
         VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`,
        id,
        taskId,
        targetPath,
        baseCommit,
        now,
        now,
        FOREMAN_ATTRIBUTION.actor_role,
        FOREMAN_ATTRIBUTION.provider,
        FOREMAN_ATTRIBUTION.model,
        FOREMAN_ATTRIBUTION.account
      );
    }

    return {
      taskId,
      path: targetPath,
      baseCommit
    };
  }
}
