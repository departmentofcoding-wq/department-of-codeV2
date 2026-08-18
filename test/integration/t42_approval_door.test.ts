import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { listNeedsReviewTasks, approveTaskInteractive } from '../../scripts/approve.ts';
import type { AttributionTuple } from '../../engine/contract/types.ts';

describe('T42: Approval Door CLI & approveTask Integration Test', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t42-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const humanAttr: AttributionTuple = {
    actor_role: 'human-operator',
    provider: 'human',
    model: 'operator',
    account: 'operator-1'
  };

  function seedTask(db: any, taskId: string, state = 'needs-review', verifierExitCode: number | null = 0) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, state, verifier_exit_code, work_uuid, created_at, updated_at)
       VALUES (?, 'Test Task Title', 'Test intent', ?, ?, 'work-123', ?, ?)`,
      taskId,
      state,
      verifierExitCode,
      now,
      now
    );
  }

  function seedWorkReview(db: any, taskId: string, verdict = 'approved', commitHash = 'abc1234') {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
       VALUES (?, ?, 'work-123', 'work', 1, ?, ?, 'senior-engineer', 'zai', 'glm-5.2', ?)`,
      `wr-${Math.random()}`,
      taskId,
      verdict,
      commitHash,
      now
    );
  }

  it('lists needs-review tasks with audit facts', () => {
    const db = openDbConnection(dbPath);
    seedTask(db, 'task-42a', 'needs-review', 0);
    seedWorkReview(db, 'task-42a', 'approved', 'hash-111');

    const tasks = listNeedsReviewTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe('task-42a');
    expect(tasks[0].verifierExitCode).toBe(0);
    expect(tasks[0].latestWorkVerdict).toBe('approved');
    expect(tasks[0].reviewedCommit).toBe('hash-111');
  });

  it('approveTaskInteractive enforces confirmation naming the task', () => {
    const db = openDbConnection(dbPath);
    seedTask(db, 'task-42b', 'needs-review', 0);

    // Wrong confirmation string fails
    expect(() => {
      approveTaskInteractive(db, 'task-42b', 'CONFIRM', humanAttr);
    }).toThrow(/Confirmation mismatch/);

    expect(() => {
      approveTaskInteractive(db, 'task-42b', 'wrong-task CONFIRM', humanAttr);
    }).toThrow(/Confirmation mismatch/);

    // Correct confirmation passes
    const approved = approveTaskInteractive(db, 'task-42b', 'task-42b CONFIRM', humanAttr);
    expect(approved.approved_at).toBeDefined();
    expect(approved.approved_by).toBe('human-operator:operator-1');
    expect(approved.state).toBe('needs-review');

    // Verify pr.create job enqueued
    const jobs = db.all("SELECT * FROM bureau_jobs WHERE task_id = 'task-42b' AND kind = 'pr.create'");
    expect(jobs).toHaveLength(1);

    // Verify human journal span created
    const spans = db.all("SELECT * FROM bureau_journal WHERE task_id = 'task-42b' AND kind = 'human'");
    expect(spans).toHaveLength(1);
  });

  it('refuses approval when verifier exit code is non-zero', () => {
    const db = openDbConnection(dbPath);
    seedTask(db, 'task-42c', 'needs-review', 1); // Exit code 1

    expect(() => {
      approveTaskInteractive(db, 'task-42c', 'task-42c CONFIRM', humanAttr);
    }).toThrow(/cannot be approved because verifier exit code is 1/);
  });

  it('is idempotent on re-approval without duplicate enqueue', () => {
    const db = openDbConnection(dbPath);
    seedTask(db, 'task-42d', 'needs-review', 0);

    const first = approveTaskInteractive(db, 'task-42d', 'task-42d CONFIRM', humanAttr);
    const second = approveTaskInteractive(db, 'task-42d', 'task-42d CONFIRM', humanAttr);

    expect(second.approved_at).toEqual(first.approved_at);

    const jobs = db.all("SELECT * FROM bureau_jobs WHERE task_id = 'task-42d' AND kind = 'pr.create'");
    expect(jobs).toHaveLength(1);
  });
});
