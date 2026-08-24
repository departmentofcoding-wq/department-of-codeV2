import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t39-t40-'));
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

describe.each(testImplementations)('T39 & T40: Senior Plan Review & Ceiling Exhaustion ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
    setMockClientOverride(null);
  });

  afterEach(() => {
    setMockClientOverride(null);
    cleanup();
  });

  it('T39: Plan review — rubric refusal before model, passing plan model verdict, transactional plan_rounds increment, & dispatch enqueue on approval', async () => {
    const mockClient = new MockClient([
      {
        text: JSON.stringify({ verdict: 'approved', feedback: 'Great plan!' }),
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
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, state, work_uuid, plan_rounds, created_at, updated_at)
       VALUES ('task-t39', 'Build Plan Review', 'Review plan', 'Spec 39', 'claimed', 'work-39', 0, ?, ?)`,
      now,
      now
    );

    // 1. Failing Plan (lacks branch, scope, tests, walkthrough)
    db.run(
      `INSERT INTO bureau_plans (id, task_id, work_uuid, round, status, plan_text, actor_role, provider, model, created_at, updated_at)
       VALUES ('plan-fail', 'task-t39', 'work-39', 0, 'draft', 'Invalid brief text', 'junior-engineer', 'ollama', 'coder', ?, ?)`,
      now,
      now
    );

    const job1Id = 'job-plan-1';
    enqueueJob(db, {
      id: job1Id,
      kind: 'senior.review-plan',
      task_id: 'task-t39',
      payload: { taskId: 'task-t39', planId: 'plan-fail' }
    });

    await drainSingleJob(db, job1Id);

    // Verify zero LLM calls were made for rubric refusal
    expect(mockClient.callHistory.length).toBe(0);

    const llmSpans = db.all(`SELECT * FROM bureau_journal WHERE kind = 'llm'`);
    expect(llmSpans.length).toBe(0);

    const guardrailSpans = db.all<{ detail: string }>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-t39'`
    );
    expect(guardrailSpans.length).toBe(1);
    expect(guardrailSpans[0].detail).includes('plan_rubric_refusal');

    const reviewRows1 = db.all<{ verdict: string; provider: string; model: string }>(
      `SELECT * FROM bureau_plan_reviews WHERE task_id = 'task-t39'`
    );
    expect(reviewRows1.length).toBe(1);
    expect(reviewRows1[0].verdict).toBe('amend');
    expect(reviewRows1[0].provider).toBe('deterministic');
    expect(reviewRows1[0].model).toBe('rubric');

    const taskAfter1 = db.get<{ plan_rounds: number }>('SELECT plan_rounds FROM bureau_tasks WHERE id = ?', 'task-t39');
    expect(taskAfter1?.plan_rounds).toBe(1);

    // 2. Passing Plan (contains branch wt/..., scope, tests & mutation, walkthrough)
    const validPlanText =
      '# Implementation Plan\n' +
      'Branch: wt/junior-a-review\n' +
      'Scope: Enumerate components in engine/review/\n' +
      'Tests: Add unit tests and mutation evidence in docs/mutation-evidence-phase4.md\n' +
      'Walkthrough: Complete verification plan and walkthrough.md';

    db.run(
      `INSERT INTO bureau_plans (id, task_id, work_uuid, round, status, plan_text, actor_role, provider, model, created_at, updated_at)
       VALUES ('plan-pass', 'task-t39', 'work-39', 1, 'draft', ?, 'junior-engineer', 'ollama', 'coder', ?, ?)`,
      validPlanText,
      now,
      now
    );

    const job2Id = 'job-plan-2';
    enqueueJob(db, {
      id: job2Id,
      kind: 'senior.review-plan',
      task_id: 'task-t39',
      payload: { taskId: 'task-t39', planId: 'plan-pass' }
    });

    await drainSingleJob(db, job2Id);

    // Verify model was called for passing rubric plan
    expect(mockClient.callHistory.length).toBe(1);

    const reviewRows2 = db.all<{ verdict: string; provider: string; model: string }>(
      `SELECT * FROM bureau_plan_reviews WHERE plan_id = 'plan-pass'`
    );
    expect(reviewRows2.length).toBe(1);
    expect(reviewRows2[0].verdict).toBe('approved');
    expect(['mock', 'ollama', 'google']).toContain(reviewRows2[0].provider);

    const taskAfter2 = db.get<{ plan_rounds: number }>('SELECT plan_rounds FROM bureau_tasks WHERE id = ?', 'task-t39');
    expect(taskAfter2?.plan_rounds).toBe(2);

    // Verify junior.dispatch job was enqueued transactionally on approval
    const dispatchJob = db.get<{ kind: string }>('SELECT * FROM bureau_jobs WHERE kind = ? AND task_id = ?', 'junior.dispatch', 'task-t39');
    expect(dispatchJob).toBeDefined();
    expect(dispatchJob?.kind).toBe('junior.dispatch');
  });

  it('T40: Plan rounds exhaustion — entry-guard blocks task at ceiling (3), notifies operator, and refuses subsequent review jobs', async () => {
    const mockClient = new MockClient([
      {
        text: JSON.stringify({ verdict: 'amend', feedback: 'Needs work' }),
        tokensIn: 100,
        tokensOut: 20,
        latencyMs: 50,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      },
      {
        text: JSON.stringify({ verdict: 'amend', feedback: 'Still needs work' }),
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
    // Pin the ceiling to 3 for this exhaustion test (the default is now 7).
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES ('review:plan_rounds_ceiling', '3')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    // Task already at plan_rounds = 2 (ceiling is 3)
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, plan_rounds, created_at, updated_at)
       VALUES ('task-t40', 'Exhaustion Task', 'claimed', 'work-40', 2, ?, ?)`,
      now,
      now
    );

    const validPlanText =
      'Branch: wt/junior-a-review\n' +
      'Scope: Engine components\n' +
      'Tests: Vitest tests and mutation evidence\n' +
      'Walkthrough: Verification plan included';

    db.run(
      `INSERT INTO bureau_plans (id, task_id, work_uuid, round, status, plan_text, actor_role, provider, model, created_at, updated_at)
       VALUES ('plan-40', 'task-t40', 'work-40', 2, 'draft', ?, 'junior-engineer', 'ollama', 'coder', ?, ?)`,
      validPlanText,
      now,
      now
    );

    // Job 1: Reaches ceiling 3 (amend verdict) -> task transitions to 'blocked'
    const job1Id = 'job-exh-1';
    enqueueJob(db, {
      id: job1Id,
      kind: 'senior.review-plan',
      task_id: 'task-t40',
      payload: { taskId: 'task-t40', planId: 'plan-40' }
    });

    await drainSingleJob(db, job1Id);

    const taskAfter1 = db.get<{ state: string; plan_rounds: number }>('SELECT state, plan_rounds FROM bureau_tasks WHERE id = ?', 'task-t40');
    expect(taskAfter1?.plan_rounds).toBe(3);
    expect(taskAfter1?.state).toBe('blocked');

    // Job 2: Task is blocked and plan_rounds >= 3 -> Entry-guard refuses without model call or rubric work
    const callsBefore = mockClient.callHistory.length;

    const job2Id = 'job-exh-2';
    enqueueJob(db, {
      id: job2Id,
      kind: 'senior.review-plan',
      task_id: 'task-t40',
      payload: { taskId: 'task-t40', planId: 'plan-40' }
    });

    await drainSingleJob(db, job2Id);

    expect(mockClient.callHistory.length).toBe(callsBefore);

    const guardrailEntrySpans = db.all<{ detail: string }>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-t40'`
    );
    expect(guardrailEntrySpans.some(s => s.detail.includes('plan_review_ceiling_exceeded'))).toBe(true);

    // Verify task plan_rounds stayed at 3 (entry-guard did NOT increment)
    const taskAfter2 = db.get<{ plan_rounds: number }>('SELECT plan_rounds FROM bureau_tasks WHERE id = ?', 'task-t40');
    expect(taskAfter2?.plan_rounds).toBe(3);
  });
});
