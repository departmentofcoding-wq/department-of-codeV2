import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttributionTuple, DbConnection, WorkspaceHandle, WorkspaceProvider } from '../../engine/contract/index.ts';

export class FakeWorkspaceProvider implements WorkspaceProvider {
  private baseDir: string;
  private handles = new Map<string, WorkspaceHandle>();
  public checkpoints: Array<{ taskId: string; attribution: AttributionTuple; note?: string }> = [];

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-fake-ws-'));
  }

  public async prepare(_db: DbConnection, taskId: string): Promise<WorkspaceHandle> {
    if (this.handles.has(taskId)) {
      return this.handles.get(taskId)!;
    }
    const wsPath = path.join(this.baseDir, taskId);
    if (!fs.existsSync(wsPath)) {
      fs.mkdirSync(wsPath, { recursive: true });
    }
    const handle: WorkspaceHandle = {
      taskId,
      path: wsPath,
      baseCommit: 'fake-commit-base-000000000000000000000000000'
    };
    this.handles.set(taskId, handle);
    return handle;
  }

  public async getWorkspaceHandle(_db: DbConnection, taskId: string): Promise<WorkspaceHandle> {
    if (!this.handles.has(taskId)) {
      return this.prepare(_db, taskId);
    }
    return this.handles.get(taskId)!;
  }

  public async checkpoint(_db: DbConnection, taskId: string, attribution: AttributionTuple, note?: string): Promise<void> {
    this.checkpoints.push({ taskId, attribution, note });
  }

  public async isClean(_db: DbConnection, _taskId: string): Promise<boolean> {
    return true;
  }

  public async prune(db: DbConnection, taskId: string): Promise<void> {
    const row = db.get<{ id: string; status: string; path: string }>(
      "SELECT * FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
      taskId
    );
    if (!row) {
      return;
    }
    if (row.status !== 'ready') {
      throw new Error(`Refusing to prune worktree for task ${taskId}: status is '${row.status}' (must be 'ready')`);
    }
    const clean = await this.isClean(db, taskId);
    if (!clean) {
      throw new Error(`Refusing to prune worktree for task ${taskId}: worktree at ${row.path} is dirty`);
    }

    const wsPath = this.handles.get(taskId)?.path ?? row.path;
    if (fs.existsSync(wsPath)) {
      try {
        fs.rmSync(wsPath, { recursive: true, force: true });
      } catch {}
    }
    this.handles.delete(taskId);

    const now = new Date().toISOString();
    db.run(
      "UPDATE bureau_worktrees SET status = 'removed', updated_at = ? WHERE id = ?",
      now,
      row.id
    );
  }

  public cleanup(): void {
    try {
      fs.rmSync(this.baseDir, { recursive: true, force: true });
    } catch {}
  }
}
