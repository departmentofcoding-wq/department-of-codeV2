import { describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauTaskRow } from '../../engine/contract/index.ts';
import { createFakeDb } from '../fixtures/db_factory.ts';
import {
  buildVerifyFixPrompt,
  handleVerifyOutcome,
  isVerifyFixSendback,
  readVerifyCeiling
} from '../../engine/verify/loop.ts';
import { JUNIOR_COMPLETION_INSTRUCTION } from '../../engine/harness/antigravity.ts';

describe('tc_verify_fix_dispatch: N1(a) Real Junior Verify-Fix Dispatch on Verify Failure', () => {
  it('readVerifyCeiling reads from bureau_meta and defaults to 2 when absent or malformed', () => {
    const db = createFakeDb();

    // Absent: returns 2
    expect(readVerifyCeiling(db)).toBe(2);

    // Explicit valid integer
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('verify:fixes:ceiling', '5')");
    expect(readVerifyCeiling(db)).toBe(5);

    // Malformed: fallback to 2
    db.run("UPDATE bureau_meta SET value = 'not-a-number' WHERE key = 'verify:fixes:ceiling'");
    expect(readVerifyCeiling(db)).toBe(2);

    // Non-positive: fallback to 2
    db.run("UPDATE bureau_meta SET value = '0' WHERE key = 'verify:fixes:ceiling'");
    expect(readVerifyCeiling(db)).toBe(2);
  });

  it('isVerifyFixSendback returns true only for failure strictly under ceiling', () => {
    const ceiling = 2;

    // Passing run (exitCode 0, not timed out): never sendback
    expect(
      isVerifyFixSendback({ verify_fixes: 0 }, { exitCode: 0, signal: null, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '' }, ceiling)
    ).toBe(false);

    // Failing run under ceiling: sendback
    expect(
      isVerifyFixSendback({ verify_fixes: 0 }, { exitCode: 1, signal: null, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '' }, ceiling)
    ).toBe(true);
    expect(
      isVerifyFixSendback({ verify_fixes: 1 }, { exitCode: 1, signal: null, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '' }, ceiling)
    ).toBe(true);

    // Timed out under ceiling: sendback
    expect(
      isVerifyFixSendback({ verify_fixes: 1 }, { exitCode: null, signal: 'SIGKILL', timedOut: true, durationMs: 1000, stdoutTail: '', stderrTail: '' }, ceiling)
    ).toBe(true);

    // Failing run at or above ceiling: no sendback (ceiling reached)
    expect(
      isVerifyFixSendback({ verify_fixes: 2 }, { exitCode: 1, signal: null, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '' }, ceiling)
    ).toBe(false);
    expect(
      isVerifyFixSendback({ verify_fixes: 3 }, { exitCode: 1, signal: null, timedOut: false, durationMs: 10, stdoutTail: '', stderrTail: '' }, ceiling)
    ).toBe(false);
  });

  it('buildVerifyFixPrompt formats failure summary, stages, task details, and completion instruction', () => {
    const task = {
      id: 'task-test-prompt',
      title: 'Fix auth header parsing',
      intent: 'Support bearer tokens with extra whitespace',
      spec: 'Trim authorization header value before validating',
      acceptance: 'All auth test cases pass',
      verify_cmd: 'npm test',
      state: 'verifying',
      verify_fixes: 0,
      priority: 1,
      work_uuid: 'uuid-prompt-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as unknown as BureauTaskRow;

    const outcome = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 1234,
      stdoutTail: 'TAP version 13\nnot ok 1 - Bearer token test failed',
      stderrTail: 'Error: invalid token format',
      stages: [
        { stage: 'structural' as const, exit_code: 0, duration_ms: 50, stdout_tail: '', stderr_tail: '' },
        { stage: 'pass-to-pass' as const, exit_code: 1, duration_ms: 100, stdout_tail: 'not ok 1', stderr_tail: 'failed' }
      ]
    };

    const prompt = buildVerifyFixPrompt(task, outcome, 1, 2, { name: 'core-api', path: '/repos/core-api' });

    expect(prompt).toContain('verify-fix round 1 of at most 2');
    expect(prompt).toContain("Stage 'pass-to-pass' failed (exit code 1)");
    expect(prompt).toContain('Exit Code: 1');
    expect(prompt).toContain('TAP version 13');
    expect(prompt).toContain('Error: invalid token format');
    expect(prompt).toContain('TITLE: Fix auth header parsing');
    expect(prompt).toContain('PROJECT: core-api (/repos/core-api)');
    expect(prompt).toContain('INTENT: Support bearer tokens with extra whitespace');
    expect(prompt).toContain('SPEC: Trim authorization header value before validating');
    expect(prompt).toContain('ACCEPTANCE: All auth test cases pass');
    expect(prompt).toContain('VERIFY_CMD: npm test');
    expect(prompt).toContain(JUNIOR_COMPLETION_INSTRUCTION);
    expect(prompt).toContain('BUREAU-JUNIOR-COMPLETE');
  });

  it('handleVerifyOutcome on failure enqueues junior.dispatch with chainWorkReview, dispatches row, and increments fixes', () => {
    const db = createFakeDb();
    const taskId = 'task-fix-dispatch-1';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'verifying', 0, 1, 'uuid-fix-1', ?, ?)`,
      taskId,
      'Task Title 1',
      'Task Intent 1',
      'Task Spec 1',
      'Task Acceptance 1',
      'npm test',
      now,
      now
    );

    const outcome = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 500,
      stdoutTail: 'Tests failed: 1 error',
      stderrTail: 'Stack trace...'
    };

    const res = handleVerifyOutcome(db, taskId, outcome);
    expect(res.isSuccess).toBe(false);
    expect(res.isSendback).toBe(true);

    // State transitioned to claimed and verify_fixes incremented
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('claimed');
    expect(task?.verify_fixes).toBe(1);

    // bureau_dispatches row was created
    const dispatches = db.all<{ id: string; task_id: string; actor_role: string; provider: string; status: string }>(
      'SELECT * FROM bureau_dispatches WHERE task_id = ?',
      taskId
    );
    expect(dispatches.length).toBe(1);
    expect(dispatches[0].actor_role).toBe('junior-engineer');
    expect(dispatches[0].provider).toBe('antigravity');
    expect(dispatches[0].status).toBe('pending');

    // Enqueued job is junior.dispatch (NOT verify.run)
    const jobs = db.all<BureauJobRow>('SELECT * FROM bureau_jobs WHERE task_id = ?', taskId);
    expect(jobs.length).toBe(1);
    expect(jobs[0].kind).toBe('junior.dispatch');

    const payload = JSON.parse(jobs[0].payload);
    expect(payload.dispatchId).toBe(dispatches[0].id);
    expect(payload.chainWorkReview).toBe(true);
    expect(payload.freshConversation).toBe(false);
    expect(payload.prompt).toContain('verify-fix round 1 of at most 2');
    expect(payload.prompt).toContain('Tests failed: 1 error');
  });

  it('determines junior assignment deterministically per task id policy (matching N3)', () => {
    const savedDefault = process.env.JUNIOR_DEFAULT;
    delete process.env.JUNIOR_DEFAULT;

    try {
      const db = createFakeDb();
      const now = new Date().toISOString();

      // Task A hash resolves to junior A (deterministic hash)
      const taskAId = '3756ec6e-4ee5-4110-aa6a-b64d3831c464';
      // Task B hash resolves to junior B (deterministic hash)
      const taskBId = 'b55e2fda-5309-42c9-a356-2a7971c98543';

      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verify_fixes, priority, work_uuid, created_at, updated_at)
         VALUES (?, 'Task A', 'verifying', 0, 1, 'uuid-a', ?, ?)`,
        taskAId,
        now,
        now
      );
      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verify_fixes, priority, work_uuid, created_at, updated_at)
         VALUES (?, 'Task B', 'verifying', 0, 1, 'uuid-b', ?, ?)`,
        taskBId,
        now,
        now
      );

      const outcome = {
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 100,
        stdoutTail: 'fail',
        stderrTail: ''
      };

      handleVerifyOutcome(db, taskAId, outcome);
      handleVerifyOutcome(db, taskBId, outcome);

      const jobA = db.get<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch'", taskAId);
      const jobB = db.get<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch'", taskBId);

      const payloadA = JSON.parse(jobA!.payload);
      const payloadB = JSON.parse(jobB!.payload);

      expect(payloadA.junior).toBe('A');
      expect(payloadB.junior).toBe('B');

      // Explicit override
      const taskCOverrideId = 'task-c-override';
      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verify_fixes, priority, work_uuid, created_at, updated_at)
         VALUES (?, 'Task C', 'verifying', 0, 1, 'uuid-c', ?, ?)`,
        taskCOverrideId,
        now,
        now
      );
      handleVerifyOutcome(db, taskCOverrideId, outcome, undefined, { junior: 'B' });
      const jobC = db.get<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch'", taskCOverrideId);
      const payloadC = JSON.parse(jobC!.payload);
      expect(payloadC.junior).toBe('B');
    } finally {
      if (savedDefault !== undefined) process.env.JUNIOR_DEFAULT = savedDefault;
      else delete process.env.JUNIOR_DEFAULT;
    }
  });

  it('enforces ceiling: transitions to blocked and notifies operator when budget exhausted without junior dispatch', () => {
    const db = createFakeDb();
    const taskId = 'task-ceiling-blocked';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, verify_fixes, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'Task Ceiling Test', 'verifying', 2, 1, 'uuid-ceiling', ?, ?)`,
      taskId,
      now,
      now
    );

    const outcome = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 200,
      stdoutTail: 'persistent failure',
      stderrTail: ''
    };

    const res = handleVerifyOutcome(db, taskId, outcome);
    expect(res.isSuccess).toBe(false);
    expect(res.isSendback).toBe(false);

    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('blocked');
    expect(task?.verify_fixes).toBe(2);

    // No junior.dispatch or verify.run jobs enqueued
    const jobs = db.all<BureauJobRow>('SELECT * FROM bureau_jobs WHERE task_id = ?', taskId);
    expect(jobs.length).toBe(0);

    // Guardrail span logged in journal
    const guardrailSpans = db.all<{ kind: string }>("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'", taskId);
    expect(guardrailSpans.length).toBe(1);
  });
});
