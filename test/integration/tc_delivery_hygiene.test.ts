import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { checkpoint } from '../../engine/worktrees/checkpoint.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

/**
 * Delivery hygiene (2026-09-06 findings):
 *  1. checkpoint() must never sweep docs/junior-artifacts/** onto a delivery
 *     branch — branch bureau-wt-05c6edc0 carried artifacts belonging to OTHER
 *     dispatch ids, pure conflict ballast between sibling tasks. The exclusion
 *     is enforced by the pathspec itself, so it protects non-dept project
 *     repos too (they do not inherit this repo's .gitignore).
 *  2. docs/mutation-evidence-phase*.md is append-only evidence; the union
 *     merge driver must auto-resolve the both-append conflict that every pair
 *     of sibling delivery branches produces there (PR #9's third conflict).
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('tc: delivery hygiene (artifact exclusion + union merge)', () => {
  let tempDir: string;
  let repoPath: string;
  let dbPath: string;
  let gitWorkspaceProvider: GitWorkspaceProvider;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-tc-hygiene-'));
    repoPath = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');

    // A plain repo with NO .gitignore — proving the exclusion does not depend
    // on one being committed.
    fs.mkdirSync(repoPath, { recursive: true });
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.name', 'Test User']);
    git(repoPath, ['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Temp Repo');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-m', 'initial commit']);
    git(repoPath, ['branch', '-M', 'main']);

    gitWorkspaceProvider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(gitWorkspaceProvider);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checkpoint commits source work but never junior artifacts, which stay on disk untracked', async () => {
    const db = openDbConnection(dbPath);
    const taskId = 'hygiene-checkpoint-1';
    // bureau_worktrees.task_id carries a foreign key into bureau_tasks.
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, work_uuid, created_at, updated_at)
       VALUES (?, 'Hygiene Task', 'Test intent', 'claimed', NULL, 'work-uuid', ?, ?)`,
      taskId,
      new Date().toISOString(),
      new Date().toISOString()
    );
    const handle = await gitWorkspaceProvider.prepare(db, taskId);

    // Real junior work plus an artifact written during the same dispatch —
    // including a FOREIGN task's artifact dir (the exact 05c6edc0 leak shape).
    fs.mkdirSync(path.join(handle.path, 'src'), { recursive: true });
    fs.writeFileSync(path.join(handle.path, 'src', 'feature.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(handle.path, 'docs', 'junior-artifacts', taskId, 'run-1'), { recursive: true });
    fs.writeFileSync(path.join(handle.path, 'docs', 'junior-artifacts', taskId, 'run-1', 'plan.md'), '# plan');
    fs.mkdirSync(path.join(handle.path, 'docs', 'junior-artifacts', 'foreign-task-id', 'run-9'), { recursive: true });
    fs.writeFileSync(path.join(handle.path, 'docs', 'junior-artifacts', 'foreign-task-id', 'run-9', 'reply.md'), 'reply');

    await checkpoint(db, taskId, { actor_role: 'junior-engineer', provider: 'antigravity', model: 'gemini', account: null });

    // The source work IS committed.
    const tracked = git(handle.path, ['ls-files']);
    expect(tracked).toContain('src/feature.ts');

    // The artifacts are NOT committed — own task's, nor the foreign one's.
    expect(tracked).not.toContain('docs/junior-artifacts');
    expect(tracked).not.toMatch(/junior-artifacts/);

    // And they survive on disk for seniors to read, left untracked.
    expect(fs.existsSync(path.join(handle.path, 'docs', 'junior-artifacts', taskId, 'run-1', 'plan.md'))).toBe(true);
    const porcelain = git(handle.path, ['status', '--porcelain', '--untracked-files=all']);
    expect(porcelain).toContain('docs/junior-artifacts/');
    expect(porcelain).not.toContain('src/feature.ts');
  });

  it('mutation-evidence ledgers auto-merge via the union driver: both-append produces no conflict', () => {
    const attrPath = path.join(repoPath, '.gitattributes');
    fs.writeFileSync(attrPath, 'docs/mutation-evidence-phase*.md merge=union\n');
    const evidencePath = path.join(repoPath, 'docs');
    fs.mkdirSync(evidencePath, { recursive: true });
    const evidenceFile = path.join(evidencePath, 'mutation-evidence-phase8.md');
    fs.writeFileSync(evidenceFile, '# Evidence\n\nM-EARLIER-1 caught by t1.\n');
    git(repoPath, ['add', '.gitattributes', 'docs/mutation-evidence-phase8.md']);
    git(repoPath, ['commit', '-m', 'base evidence']);

    // Two sibling delivery branches, each appending its own block at the EOF —
    // the guaranteed both-append conflict of the old world.
    git(repoPath, ['checkout', '-b', 'task-branch']);
    fs.appendFileSync(evidenceFile, '\nM-TASK-A-1 caught by tc_x.\n');
    git(repoPath, ['add', 'docs/mutation-evidence-phase8.md']);
    git(repoPath, ['commit', '-m', 'task A evidence']);

    git(repoPath, ['checkout', 'main']);
    fs.appendFileSync(evidenceFile, '\nM-TASK-B-1 caught by tc_y.\n');
    git(repoPath, ['add', 'docs/mutation-evidence-phase8.md']);
    git(repoPath, ['commit', '-m', 'task B evidence']);

    git(repoPath, ['checkout', 'task-branch']);
    // Without the union driver this merge exits non-zero with conflict
    // markers in the file (the PR #9 failure class).
    git(repoPath, ['merge', 'main', '--no-edit']);

    const merged = fs.readFileSync(evidenceFile, 'utf-8');
    expect(merged).toContain('M-TASK-A-1');
    expect(merged).toContain('M-TASK-B-1');
    expect(merged).not.toContain('<<<<<<<');
    expect(merged).not.toContain('>>>>>>>');
  });
});
