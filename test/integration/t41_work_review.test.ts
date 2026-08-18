import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';
import { setMockClientOverride } from '../../engine/contract/llm-seam.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { drainSingleJob } from '../../runner/main.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t41-'));
      const dbPath = path.join(tmpDir, 'test.db');
      const db = createRealSqliteDb(dbPath);
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

describe.each(testImplementations)('T41: Senior Work Review Gate ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;
  let worktreeTmpDir: string;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
    setMockClientOverride(null);

    // Create a temporary git repo acting as the task's worktree
    worktreeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-wt-t41-'));
    execSync('git init', { cwd: worktreeTmpDir, stdio: 'ignore' });
    execSync('git config user.name "Bureau Test"', { cwd: worktreeTmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@bureau.local"', { cwd: worktreeTmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktreeTmpDir, 'README.md'), '# Worktree Test Repo');
    execSync('git add README.md', { cwd: worktreeTmpDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', { cwd: worktreeTmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    setMockClientOverride(null);
    if (worktreeTmpDir && fs.existsSync(worktreeTmpDir)) {
      fs.rmSync(worktreeTmpDir, { recursive: true, force: true });
    }
    cleanup();
  });

  it('T41: Work review gate — refuses on precondition failure without model call; passing preconditions record tip commit hash', async () => {
    const mockClient = new MockClient([
      {
        text: JSON.stringify({ verdict: 'approved', comments: 'Code looks solid!' }),
        tokensIn: 100,
        tokensOut: 20,
        latencyMs: 50,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      }
    ]);
    setMockClientOverride(mockClient);

    const now = new Date().toISOString();
    const baseCommit = execSync('git rev-parse HEAD', { cwd: worktreeTmpDir, encoding: 'utf8' }).trim();

    // 1. Task with verifier_exit_code = 1 (Precondition failure)
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, work_uuid, cycles, created_at, updated_at)
       VALUES ('task-t41', 'Work Review Task', 'needs-review', 1, 'work-41', 0, ?, ?)`,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model, account)
       VALUES ('wt-41', 'task-t41', ?, ?, 'ready', ?, ?, 'junior-engineer', 'git', 'local', NULL)`,
      worktreeTmpDir,
      baseCommit,
      now,
      now
    );

    const job1Id = 'job-work-1';
    enqueueJob(db, {
      id: job1Id,
      kind: 'senior.review-work',
      task_id: 'task-t41',
      payload: { taskId: 'task-t41' }
    });

    await drainSingleJob(db, job1Id);

    // Verify model was NOT called
    expect(mockClient.callHistory.length).toBe(0);

    const guardrailSpans = db.all<{ detail: string }>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-t41'`
    );
    expect(guardrailSpans.length).toBe(1);
    expect(guardrailSpans[0].detail).includes('work_preconditions_refusal');

    const reviewRows1 = db.all<{ verdict: string; reviewed_commit: string; provider: string }>(
      `SELECT * FROM bureau_work_reviews WHERE task_id = 'task-t41'`
    );
    expect(reviewRows1.length).toBe(1);
    expect(reviewRows1[0].verdict).toBe('rejected');
    expect(reviewRows1[0].provider).toBe('deterministic');
    expect(reviewRows1[0].reviewed_commit).toBe(baseCommit);

    // 2. Fix task preconditions: set verifier_exit_code = 0 and create required worktree files
    db.run(`UPDATE bureau_tasks SET verifier_exit_code = 0 WHERE id = 'task-t41'`);

    // Write walkthrough and mutation evidence inside task worktree filesystem
    fs.writeFileSync(path.join(worktreeTmpDir, 'walkthrough.md'), '# Walkthrough\nVerified suite and build cleanly.');
    fs.mkdirSync(path.join(worktreeTmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeTmpDir, 'docs', 'mutation-evidence-phase4.md'),
      '# Mutation Evidence Phase 4\nGuard broken: verifier exit check\nTest that caught it: t41_work_review.test.ts'
    );

    execSync('git add .', { cwd: worktreeTmpDir, stdio: 'ignore' });
    execSync('git commit -m "add walkthrough and mutation evidence"', { cwd: worktreeTmpDir, stdio: 'ignore' });

    const newTipCommit = execSync('git rev-parse HEAD', { cwd: worktreeTmpDir, encoding: 'utf8' }).trim();
    expect(newTipCommit).not.toBe(baseCommit);

    const job2Id = 'job-work-2';
    enqueueJob(db, {
      id: job2Id,
      kind: 'senior.review-work',
      task_id: 'task-t41',
      payload: { taskId: 'task-t41' }
    });

    await drainSingleJob(db, job2Id);

    // Verify model WAS called for passing preconditions
    expect(mockClient.callHistory.length).toBe(1);

    const reviewRows2 = db.all<{ verdict: string; reviewed_commit: string; provider: string }>(
      `SELECT * FROM bureau_work_reviews WHERE task_id = 'task-t41' AND verdict = 'approved'`
    );
    expect(reviewRows2.length).toBe(1);
    expect(reviewRows2[0].reviewed_commit).toBe(newTipCommit);
    expect(['mock', 'ollama']).toContain(reviewRows2[0].provider);
  }, 30000);
});
