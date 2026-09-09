import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbConnection, WorkspaceProvider } from '../../engine/contract/index.ts';
import { reconcileDeadDispatchWork } from '../../engine/harness/salvage-detector.ts';
import { setJuniorProviderOverride } from '../../engine/contract/junior-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-r1-'));
      const db = createRealSqliteDb(path.join(tmpDir, 'test.db'));
      return {
        db,
        cleanup: () => {
          db.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      };
    }
  }
];

/** A workspace provider pinned to one path — the task's "worktree". */
class StaticWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly wsPath: string) {}
  public async prepare(_db: DbConnection, taskId: string) {
    return { taskId, path: this.wsPath, baseCommit: 'base-0000000000000000000000000000000000000000' };
  }
  public async getWorkspaceHandle(_db: DbConnection, taskId: string) {
    return { taskId, path: this.wsPath, baseCommit: 'base-0000000000000000000000000000000000000000' };
  }
  public async isClean(): Promise<boolean> {
    return false;
  }
  public async checkpoint(): Promise<void> {}
  public async prune(): Promise<void> {}
}

function insertTask(db: DbConnection, id: string, state: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, work_title, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    id,
    `Task ${id}`,
    state,
    `work-${id}`,
    `Task ${id}`,
    now,
    now
  );
}

function insertDispatch(db: DbConnection, id: string, taskId: string, status: string): void {
  db.run(
    `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, created_at)
     VALUES (?, ?, ?, 'junior-engineer', 'antigravity', 'unspecified', ?, ?)`,
    id,
    taskId,
    `work-${taskId}`,
    status,
    new Date().toISOString()
  );
}

function insertDeadDispatchJob(db: DbConnection, id: string, taskId: string, dispatchId: string) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, created_at, finished_at)
     VALUES (?, 'junior.dispatch', ?, ?, 'dead', 3, 3, 0, ?, ?)`,
    id,
    taskId,
    JSON.stringify({ dispatchId }),
    now,
    now
  );
  return db.get<any>('SELECT * FROM bureau_jobs WHERE id = ?', id);
}

describe.each(testImplementations)('R1: salvage detector live-sibling guard ($name)', ({ create }) => {
  let db: DbConnection;
  let cleanup: () => void;
  let worktreeDir: string;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
    setJuniorProviderOverride({ brainDir: () => null });

    // A real git repo left DIRTY — genuine detectable work, so the only thing
    // that can skip the salvage is the live-sibling guard under test.
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-r1-wt-'));
    execSync('git init', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git config user.name "Bureau Test"', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git config user.email "test@bureau.local"', { cwd: worktreeDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktreeDir, 'app.js'), 'console.log(1);\n');
    execSync('git add app.js', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git commit -m init', { cwd: worktreeDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktreeDir, 'app.js'), 'console.log(2); // junior WIP\n');
    setWorkspaceProvider(new StaticWorkspaceProvider(worktreeDir));
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    setJuniorProviderOverride(null);
    if (worktreeDir && fs.existsSync(worktreeDir)) {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
    cleanup();
  });

  it('skips salvage (no block) when a sibling dispatch is still running — even with detectable work', async () => {
    insertTask(db, 'task-r1-live', 'claimed');
    insertDispatch(db, 'dispatch-live', 'task-r1-live', 'running');
    insertDispatch(db, 'dispatch-dead', 'task-r1-live', 'running');
    const job = insertDeadDispatchJob(db, 'job-r1-live', 'task-r1-live', 'dispatch-dead');

    const salvaged = await reconcileDeadDispatchWork(db, job, "Window target 'window-B' is already leased by an active dispatch.");

    expect(salvaged).toBe(false);

    const task = db.get<{ state: string }>("SELECT state FROM bureau_tasks WHERE id = 'task-r1-live'");
    expect(task?.state).toBe('claimed');

    const skipSpan = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-r1-live'`
    );
    expect(skipSpan?.detail).toContain('dead_dispatch_skipped_live_sibling');
    expect(skipSpan?.detail).toContain('dispatch-live');
    expect(skipSpan?.detail).toContain('dispatch-dead');

    // The live sibling is untouched.
    const sibling = db.get<{ status: string }>("SELECT status FROM bureau_dispatches WHERE id = 'dispatch-live'");
    expect(sibling?.status).toBe('running');
  });

  it('still salvages and blocks when the dead dispatch is the ONLY one and work is detected', async () => {
    insertTask(db, 'task-r1-solo', 'claimed');
    insertDispatch(db, 'dispatch-solo', 'task-r1-solo', 'running');
    const job = insertDeadDispatchJob(db, 'job-r1-solo', 'task-r1-solo', 'dispatch-solo');

    const salvaged = await reconcileDeadDispatchWork(db, job, 'CDP timeout: Runtime.evaluate');

    expect(salvaged).toBe(true);
    const task = db.get<{ state: string }>("SELECT state FROM bureau_tasks WHERE id = 'task-r1-solo'");
    expect(task?.state).toBe('blocked');
    const span = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-r1-solo'`
    );
    expect(span?.detail).toContain('dead_dispatch_work_detected');
  });

  it('does not salvage (no block) when no work is detected and no sibling exists', async () => {
    // Clean worktree + no brain dir → nothing to salvage.
    execSync('git add app.js', { cwd: worktreeDir, stdio: 'ignore' });
    execSync('git commit -m wip', { cwd: worktreeDir, stdio: 'ignore' });

    insertTask(db, 'task-r1-clean', 'claimed');
    insertDispatch(db, 'dispatch-clean', 'task-r1-clean', 'running');
    const job = insertDeadDispatchJob(db, 'job-r1-clean', 'task-r1-clean', 'dispatch-clean');

    const salvaged = await reconcileDeadDispatchWork(db, job, 'CDP timeout: Runtime.evaluate');

    expect(salvaged).toBe(false);
    const task = db.get<{ state: string }>("SELECT state FROM bureau_tasks WHERE id = 'task-r1-clean'");
    expect(task?.state).toBe('claimed');
  });
});
