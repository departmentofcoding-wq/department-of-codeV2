import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple, BureauJournalRow } from '../../engine/contract/index.ts';
import { fileTask } from '../../engine/filing/file_task.ts';
import { confirmVerify, createSession, updateSessionDraft } from '../../engine/intake/index.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-filetask-test-'));
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

const officerAttr: AttributionTuple = {
  actor_role: 'task-intake-officer',
  provider: 'ollama',
  model: 'llama3',
  account: null
};

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'adith'
};

describe.each(testImplementations)('Filing Door fileTask Unit Tests ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('refuses to file task if session has missing gaps (title, intent, verify_cmd, or unconfirmed)', () => {
    const session = createSession(db, { attribution: officerAttr });

    // Missing title & intent & verify_cmd & confirmation
    expect(() => {
      fileTask(db, session.id, officerAttr);
    }).toThrow(/missing required gaps: title, intent, verify_cmd, verify_confirmed/);

    // Provide title and intent only
    updateSessionDraft(db, session.id, {
      title: 'Fix auth',
      intent: 'Resolve 500 error on login'
    });

    expect(() => {
      fileTask(db, session.id, officerAttr);
    }).toThrow(/missing required gaps: verify_cmd, verify_confirmed/);

    // Provide vacuous verify command
    updateSessionDraft(db, session.id, { verify_cmd: 'exit 0' });

    expect(() => {
      fileTask(db, session.id, officerAttr);
    }).toThrow(/missing required gaps: verify_cmd, verify_confirmed/);

    // Provide non-vacuous verify_cmd but do not confirm as human
    updateSessionDraft(db, session.id, { verify_cmd: 'npm test' });

    expect(() => {
      fileTask(db, session.id, officerAttr);
    }).toThrow(/missing required gaps: verify_confirmed/);
  });

  it('successfully files a task born queued, mints work_uuid, links intake_session_id, and journals task-filed span', () => {
    const session = createSession(db, {
      idempotencyKey: 'idem-file-1',
      attribution: officerAttr
    });

    updateSessionDraft(db, session.id, {
      title: 'Fix Auth Lockout',
      intent: 'Prevent accounts from locking up on password reset',
      spec: 'Add lockout timer clear',
      acceptance: 'Lockout resets after 15m',
      verify_cmd: 'npm test -- auth'
    });

    confirmVerify(db, session.id, humanAttr);

    const task = fileTask(db, session.id, officerAttr);

    expect(task.id).toBeDefined();
    expect(task.title).toBe('Fix Auth Lockout');
    expect(task.intent).toBe('Prevent accounts from locking up on password reset');
    expect(task.verify_cmd).toBe('npm test -- auth');
    expect(task.state).toBe('queued');
    expect(task.work_uuid).toBeDefined();
    expect(task.work_title).toBe('Fix Auth Lockout');
    expect(task.intake_session_id).toBe(session.id);

    // Assert session state updated to filed
    const sessionAfter = db.get<{ state: string }>('SELECT state FROM bureau_intake_sessions WHERE id = ?', session.id);
    expect(sessionAfter?.state).toBe('filed');

    // Assert exactly one task-filed journal span created with backfilled work_uuid
    const filedSpans = db.all<BureauJournalRow>(
      `SELECT * FROM bureau_journal WHERE kind = 'task-filed'`
    );
    expect(filedSpans).toHaveLength(1);
    expect(filedSpans[0].task_id).toBe(task.id);
    expect(filedSpans[0].work_uuid).toBe(task.work_uuid);
    expect(filedSpans[0].work_title).toBe(task.work_title);
    expect(filedSpans[0].actor_role).toBe(officerAttr.actor_role);
  });

  it('N17 queue: filing does NOT kick off the flow — the task waits unassigned for the queue manager', () => {
    const session = createSession(db, {
      idempotencyKey: 'idem-kickoff-1',
      attribution: officerAttr
    });

    updateSessionDraft(db, session.id, {
      title: 'Auto Kickoff Task',
      intent: 'Flow should start on its own',
      verify_cmd: 'npm test'
    });
    confirmVerify(db, session.id, humanAttr);

    const task = fileTask(db, session.id, officerAttr);

    // Filing no longer enqueues plan.cycle (the 2026-09-02 incident: three
    // tasks filed within 42s all claimed at once). The queue manager
    // (reconcileQueuedTasks) is the sole kickoff door — see tc_flow_assignment_queue.
    const cycleJobs = db.all(
      `SELECT id FROM bureau_jobs WHERE kind = 'plan.cycle'`
    );
    expect(cycleJobs).toHaveLength(0);
    // The task sits queued with NO claim-time assignment yet.
    const row = db.get<{ state: string; assigned_junior: string | null; assigned_senior: string | null }>(
      'SELECT state, assigned_junior, assigned_senior FROM bureau_tasks WHERE id = ?',
      task.id
    );
    expect(row?.state).toBe('queued');
    expect(row?.assigned_junior).toBeNull();
    expect(row?.assigned_senior).toBeNull();
  });

  it('N17 queue: re-filing a session never spawns a plan.cycle either (idempotent)', () => {
    const session = createSession(db, {
      idempotencyKey: 'idem-kickoff-2',
      attribution: officerAttr
    });

    updateSessionDraft(db, session.id, {
      title: 'Idempotent Kickoff',
      intent: 'One cycle only',
      verify_cmd: 'npm test'
    });
    confirmVerify(db, session.id, humanAttr);

    fileTask(db, session.id, officerAttr);
    fileTask(db, session.id, officerAttr);

    const cycleJobs = db.all(`SELECT id FROM bureau_jobs WHERE kind = 'plan.cycle'`);
    expect(cycleJobs).toHaveLength(0);
  });

  it('honors idempotency: re-filing an already filed session returns the existing task', () => {
    const session = createSession(db, {
      idempotencyKey: 'idem-file-repeat',
      attribution: officerAttr
    });

    updateSessionDraft(db, session.id, {
      title: 'Repeat Task',
      intent: 'Testing idempotency',
      verify_cmd: 'npm test'
    });

    confirmVerify(db, session.id, humanAttr);

    const firstTask = fileTask(db, session.id, officerAttr);
    const secondTask = fileTask(db, session.id, officerAttr);

    expect(secondTask).toEqual(firstTask);

    // Assert only one task exists in DB
    const allTasks = db.all('SELECT * FROM bureau_tasks');
    expect(allTasks).toHaveLength(1);
  });
});
