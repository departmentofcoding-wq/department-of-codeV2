import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { registerProject, getProject, listProjects, resolveProjectPath } from '../../engine/projects/manager.ts';
import type { AttributionTuple, BureauJournalRow } from '../../engine/contract/types.ts';
import { getRepoRoot } from '../../engine/worktrees/manager.ts';

const testAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

describe('Project Management Core (engine/projects/manager.ts)', () => {
  let db: ReturnType<typeof createFakeDb>;
  let tempDirs: string[] = [];

  function createTempGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-proj-test-'));
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
    db.close();
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs = [];
  });

  it('registers a project successfully and journals a project-registered span', () => {
    const repoPath = createTempGitRepo();
    const proj = registerProject(db, {
      name: 'alpha-service',
      pathToRepo: repoPath,
      description: 'Alpha backend service',
      attribution: testAttr
    });

    expect(proj.id).toBeDefined();
    expect(proj.name).toBe('alpha-service');
    expect(proj.path_to_repo).toBe(path.resolve(repoPath));
    expect(proj.description).toBe('Alpha backend service');
    expect(proj.created_at).toBeDefined();

    // Verify database row
    const row = getProject(db, proj.id);
    expect(row).toBeDefined();
    expect(row?.name).toBe('alpha-service');

    // Verify journal span
    const spans = db.all<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'project-registered'"
    );
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('project-registered');
    const detail = JSON.parse(spans[0].detail);
    expect(detail.name).toBe('alpha-service');
    expect(detail.pathToRepo).toBe(path.resolve(repoPath));
  });

  it('appends /.bureau-worktrees/ to .gitignore upon registration', () => {
    const repoPath = createTempGitRepo();
    const gitignoreFile = path.join(repoPath, '.gitignore');
    fs.writeFileSync(gitignoreFile, 'node_modules/\n', 'utf8');

    registerProject(db, {
      name: 'beta-service',
      pathToRepo: repoPath,
      attribution: testAttr
    });

    const content = fs.readFileSync(gitignoreFile, 'utf8');
    expect(content).toContain('/.bureau-worktrees/');
  });

  it('refuses registration if target path does not exist on disk', () => {
    const nonExistentPath = path.join(os.tmpdir(), 'non-existent-dir-' + Date.now());
    expect(() => {
      registerProject(db, {
        name: 'ghost-project',
        pathToRepo: nonExistentPath,
        attribution: testAttr
      });
    }).toThrow(/Target path does not exist on disk/);
  });

  it('refuses registration if target path is not a git repository', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-nongit-'));
    tempDirs.push(nonGitDir);

    expect(() => {
      registerProject(db, {
        name: 'plain-folder',
        pathToRepo: nonGitDir,
        attribution: testAttr
      });
    }).toThrow(/Target path is not a valid git repository/);
  });

  it('refuses registration on duplicate project name', () => {
    const repo1 = createTempGitRepo();
    const repo2 = createTempGitRepo();

    registerProject(db, {
      name: 'unique-service',
      pathToRepo: repo1,
      attribution: testAttr
    });

    expect(() => {
      registerProject(db, {
        name: 'unique-service',
        pathToRepo: repo2,
        attribution: testAttr
      });
    }).toThrow(/Project with name 'unique-service' already exists/);
  });

  it('retrieves project by UUID and by name', () => {
    const repoPath = createTempGitRepo();
    const created = registerProject(db, {
      name: 'lookup-service',
      pathToRepo: repoPath,
      attribution: testAttr
    });

    const byId = getProject(db, created.id);
    const byName = getProject(db, 'lookup-service');
    const missing = getProject(db, 'non-existent');

    expect(byId?.id).toBe(created.id);
    expect(byName?.id).toBe(created.id);
    expect(missing).toBeNull();
  });

  it('lists all registered projects in chronological order', () => {
    const repo1 = createTempGitRepo();
    const repo2 = createTempGitRepo();

    registerProject(db, { name: 'proj-1', pathToRepo: repo1, attribution: testAttr });
    registerProject(db, { name: 'proj-2', pathToRepo: repo2, attribution: testAttr });

    const list = listProjects(db);
    expect(list.length).toBe(2);
    expect(list[0].name).toBe('proj-1');
    expect(list[1].name).toBe('proj-2');
  });

  it('resolves project path with fallback to bureau root', () => {
    const repoPath = createTempGitRepo();
    const proj = registerProject(db, { name: 'path-service', pathToRepo: repoPath, attribution: testAttr });

    const resolved = resolveProjectPath(db, proj.id);
    expect(resolved).toBe(path.resolve(repoPath));

    const rootFallback = resolveProjectPath(db, null);
    expect(rootFallback).toBe(getRepoRoot());

    const unknownFallback = resolveProjectPath(db, 'unknown-id');
    expect(unknownFallback).toBe(getRepoRoot());
  });
});
