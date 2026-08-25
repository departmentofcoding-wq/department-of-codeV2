import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';
import { createSession, getSession, updateSessionDraft, confirmVerify } from '../../engine/intake/index.ts';
import { fileTask } from '../../engine/filing/file_task.ts';
import { registerProject } from '../../engine/projects/manager.ts';
import { buildLlmHistory } from '../../engine/officers/task_intake_officer.ts';
import type { AttributionTuple, BureauIntakeMessageRow } from '../../engine/contract/types.ts';

const testAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

describe('Project Intake & Task Filing (engine/intake, engine/filing)', () => {
  let db: ReturnType<typeof createFakeDb>;
  let tempDirs: string[] = [];

  function createTempGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-intake-proj-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'test@bureau.local'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Test Bureau'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial commit'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    return dir;
  }

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {}
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs = [];
  });

  it('createSession stores projectId when provided, and null when omitted', () => {
    const repoPath = createTempGitRepo();
    const proj = registerProject(db, { name: 'intake-proj', pathToRepo: repoPath, attribution: testAttr });

    const sessionWithProj = createSession(db, {
      title: 'Task with project',
      projectId: proj.id,
      attribution: testAttr
    });
    expect(sessionWithProj.project_id).toBe(proj.id);

    const sessionWithoutProj = createSession(db, {
      title: 'Task without project',
      attribution: testAttr
    });
    expect(sessionWithoutProj.project_id).toBeNull();
  });

  it('updateSessionDraft updates projectId', () => {
    const repo1 = createTempGitRepo();
    const repo2 = createTempGitRepo();
    const proj1 = registerProject(db, { name: 'proj-1', pathToRepo: repo1, attribution: testAttr });
    const proj2 = registerProject(db, { name: 'proj-2', pathToRepo: repo2, attribution: testAttr });

    const session = createSession(db, {
      title: 'Draft task',
      projectId: proj1.id,
      attribution: testAttr
    });
    expect(session.project_id).toBe(proj1.id);

    const updated = updateSessionDraft(db, session.id, {
      projectId: proj2.id
    });
    expect(updated.project_id).toBe(proj2.id);

    const reRead = getSession(db, session.id);
    expect(reRead?.project_id).toBe(proj2.id);
  });

  it('fileTask propagates session.project_id to bureau_tasks.project_id', () => {
    const repoPath = createTempGitRepo();
    const proj = registerProject(db, { name: 'filing-proj', pathToRepo: repoPath, attribution: testAttr });

    const session = createSession(db, {
      title: 'Filing task',
      intent: 'Build multi repo feature',
      spec: 'Add projects table',
      acceptance: 'Works as expected',
      verifyCmd: 'npm test',
      projectId: proj.id,
      attribution: testAttr
    });
    confirmVerify(db, session.id, testAttr);

    const task = fileTask(db, session.id, testAttr);
    expect(task.id).toBeDefined();
    expect(task.project_id).toBe(proj.id);
  });

  it('fileTask handles task without project (project_id is null)', () => {
    const session = createSession(db, {
      title: 'Root repo task',
      intent: 'Root fix',
      spec: 'Fix root',
      acceptance: 'Root green',
      verifyCmd: 'npm test',
      attribution: testAttr
    });
    confirmVerify(db, session.id, testAttr);

    const task = fileTask(db, session.id, testAttr);
    expect(task.project_id).toBeNull();
  });

  it('Task Intake Officer history includes registered projects list in system prompt', () => {
    const repo1 = createTempGitRepo();
    const proj = registerProject(db, {
      name: 'officer-proj',
      pathToRepo: repo1,
      description: 'Project for officer context test',
      attribution: testAttr
    });

    const messages: BureauIntakeMessageRow[] = [];
    const history = buildLlmHistory(messages, db);

    expect(history.length).toBe(1);
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('Registered Projects:');
    expect(history[0].content).toContain('officer-proj');
    expect(history[0].content).toContain(proj.id);
  });

  it('boot migrations handle bureau_projects table and project_id columns across database restarts', () => {
    const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-db-test-'));
    tempDirs.push(tempDbDir);
    const dbPath = path.join(tempDbDir, 'test_boot.db');

    // 1. Initial boot
    const db1 = createRealSqliteDb(dbPath);
    const repoPath = createTempGitRepo();
    const proj = registerProject(db1, { name: 'persisted-proj', pathToRepo: repoPath, attribution: testAttr });

    const session = createSession(db1, {
      title: 'Persisted task',
      intent: 'Verify boot',
      verifyCmd: 'npm test',
      projectId: proj.id,
      attribution: testAttr
    });
    confirmVerify(db1, session.id, testAttr);
    const task = fileTask(db1, session.id, testAttr);
    db1.close();

    // 2. Re-open / reboot database
    const db2 = createRealSqliteDb(dbPath);
    const reloadedTask = db2.get<{ id: string; project_id: string }>(
      'SELECT id, project_id FROM bureau_tasks WHERE id = ?',
      task.id
    );
    expect(reloadedTask?.project_id).toBe(proj.id);

    const reloadedProj = db2.get<{ id: string; name: string }>(
      'SELECT id, name FROM bureau_projects WHERE id = ?',
      proj.id
    );
    expect(reloadedProj?.name).toBe('persisted-proj');
    db2.close();
  });
});
