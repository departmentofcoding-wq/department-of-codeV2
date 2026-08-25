import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { registerProject } from '../../engine/projects/manager.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { runPlanReviewCycle } from '../../engine/flow/plan_review_cycle.ts';
import type { AttributionTuple } from '../../engine/contract/types.ts';

const testAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

const GOOD_PLAN = [
  'Implementation Plan',
  'Branch: wt/secondary-feature',
  'Scope: components and files',
  'Tests: unit test added, mutation evidence recorded.',
  'Walkthrough: verification plan and test suite run twice.'
].join('\n');

describe('Multi-Repository Execution & Routing (tc_multi_repo_execution.test.ts)', () => {
  let db: ReturnType<typeof createFakeDb>;
  let tempDirs: string[] = [];

  function createTempGitRepo(branchName = 'main'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-exec-test-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', branchName], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.email', 'test@bureau.local'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['config', 'user.name', 'Test Bureau'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial commit on ' + branchName], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    return dir;
  }

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
    db.close();
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs = [];
  });

  it('prepares worktree in secondary master-defaulted project repository without failing on main branch check', async () => {
    const defaultRoot = createTempGitRepo('main');
    const secondaryMasterRepo = createTempGitRepo('master');

    const proj = registerProject(db, {
      name: 'secondary-master-app',
      pathToRepo: secondaryMasterRepo,
      description: 'Secondary repo with master branch',
      attribution: testAttr
    });

    const taskId = 'task-master-123';
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, project_id, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Add feature in master repo', ?, 'claimed', 'work-123', ?, ?)`,
      taskId,
      proj.id,
      now,
      now
    );

    const provider = new GitWorkspaceProvider(defaultRoot);
    const handle = await provider.prepare(db, taskId);

    expect(handle.taskId).toBe(taskId);
    // Path should be inside secondaryMasterRepo, NOT defaultRoot
    expect(handle.path).toBe(path.join(path.resolve(secondaryMasterRepo), '.bureau-worktrees', taskId));
    expect(fs.existsSync(handle.path)).toBe(true);

    // Verify git branch inside the worktree
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: handle.path,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    expect(branch).toBe(`bureau-wt-${taskId}`);
  });

  it('prepares worktree in default bureau root when task has no project_id (NULL fallback)', async () => {
    const defaultRoot = createTempGitRepo('main');
    const taskId = 'task-root-456';
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, project_id, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Root repo task', NULL, 'claimed', 'work-456', ?, ?)`,
      taskId,
      now,
      now
    );

    const provider = new GitWorkspaceProvider(defaultRoot);
    const handle = await provider.prepare(db, taskId);

    expect(handle.taskId).toBe(taskId);
    expect(handle.path).toBe(path.join(path.resolve(defaultRoot), '.bureau-worktrees', taskId));
    expect(fs.existsSync(handle.path)).toBe(true);
  });

  it('runPlanReviewCycle threads project folder and context into junior and senior dispatches', async () => {
    const secondaryRepo = createTempGitRepo('main');
    const proj = registerProject(db, {
      name: 'dispatch-app',
      pathToRepo: secondaryRepo,
      attribution: testAttr
    });

    const taskId = 'task-plan-789';
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, project_id, state, work_uuid, plan_rounds, created_at, updated_at)
       VALUES (?, 'Build user service', 'add user login', 'auth spec', 'login works', ?, 'claimed', 'work-789', 0, ?, ?)`,
      taskId,
      proj.id,
      now,
      now
    );

    let juniorReceivedFolder: string | undefined;
    let juniorReceivedPrompt: string | undefined;
    setAntigravityDriverOverride({
      async runCommand(prompt: string, opts?: any) {
        juniorReceivedPrompt = prompt;
        juniorReceivedFolder = opts?.folder;
        return {
          plan: GOOD_PLAN,
          fullOutput: GOOD_PLAN
        };
      }
    } as any);

    let seniorReceivedProjectName: string | undefined;
    let seniorReceivedProjectPath: string | undefined;
    setSeniorDriverOverride({
      async review(input: any) {
        seniorReceivedProjectName = input.projectName;
        seniorReceivedProjectPath = input.projectPath;
        return {
          senior: 'claude',
          verdict: 'approve',
          feedback: 'Plan looks great',
          raw: 'VERDICT: APPROVE\nPlan looks great'
        };
      }
    });

    const result = await runPlanReviewCycle(db, { taskId });

    expect(result.outcome).toBe('approved');
    // Verify junior received the project folder
    expect(juniorReceivedFolder).toBe(path.resolve(secondaryRepo));
    expect(juniorReceivedPrompt).toContain(`PROJECT: dispatch-app (${path.resolve(secondaryRepo)})`);
    // Verify senior received project context
    expect(seniorReceivedProjectName).toBe('dispatch-app');
    expect(seniorReceivedProjectPath).toBe(path.resolve(secondaryRepo));
  });
});
