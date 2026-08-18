import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDbConnection, closeDatabase } from '../db/index.ts';
import { canTransition, transition, approveTask } from './machine.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AttributionTuple, BureauTaskRow } from '../contract/index.ts';

describe('A2: Pure State Machine & Task Approval', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-state-'));
    dbPath = path.join(tempDir, 'test.db');
    const db = openDbConnection(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const seniorAttr: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: 'zai',
    model: 'glm-5.2',
    account: 'zcode'
  };

  const humanAttr: AttributionTuple = {
    actor_role: 'human-operator',
    provider: 'human',
    model: 'operator',
    account: 'admin'
  };

  const juniorAttr: AttributionTuple = {
    actor_role: 'junior-engineer',
    provider: 'antigravity',
    model: 'gemini-3.6-flash',
    account: null
  };

  function seedTask(taskId = 'task-1', initialState = 'needs-review', verifierExitCode: number | null = 0): BureauTaskRow {
    const db = openDbConnection(dbPath);
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO bureau_tasks (
        id, title, state, verifier_exit_code, work_uuid, created_at, updated_at
      ) VALUES (?, 'Test Task', ?, ?, 'work-123', ?, ?)
      RETURNING *
    `);
    return stmt.get(taskId, initialState, verifierExitCode, now, now) as unknown as BureauTaskRow;
  }

  it('canTransition returns true for valid transitions and enforces human-operator or system for done', () => {
    expect(canTransition('intake', 'queued', 'senior-engineer')).toBe(true);
    expect(canTransition('queued', 'claimed', 'junior-engineer')).toBe(true);
    expect(canTransition('claimed', 'verifying', 'junior-engineer')).toBe(true);
    expect(canTransition('verifying', 'needs-review', 'verifier')).toBe(true);

    // needs-review -> done for human-operator or system
    expect(canTransition('needs-review', 'done', 'senior-engineer')).toBe(false);
    expect(canTransition('needs-review', 'done', 'human-operator')).toBe(true);
    expect(canTransition('needs-review', 'done', 'system')).toBe(true);

    // Invalid path
    expect(canTransition('intake', 'done', 'human-operator')).toBe(false);
  });

  it('T1: done-gate — writing done without approval/exit 0 is refused at code level and DB CHECK constraint', () => {
    const db = openDbConnection(dbPath);
    seedTask('t-unapproved', 'needs-review', null); // verifier_exit_code is null

    // Code level refusal: non-human/non-system role cannot transition to done
    expect(() => {
      transition(db, 't-unapproved', 'done', seniorAttr);
    }).toThrow(/Illegal state transition/);

    // Code level refusal: approveTask throws if verifier_exit_code is not 0
    expect(() => {
      approveTask(db, 't-unapproved', humanAttr);
    }).toThrow(/cannot be approved because verifier exit code/);

    // Raw SQL write refusal: direct SQL UPDATE to done without approved_at/approved_by or exit code fails DB CHECK
    expect(() => {
      db.prepare("UPDATE bureau_tasks SET state = 'done' WHERE id = 't-unapproved'").run();
    }).toThrow(/CHECK constraint failed/);

    // Raw SQL write refusal: setting merged_at when state is not done fails DB CHECK constraint
    expect(() => {
      db.prepare("UPDATE bureau_tasks SET merged_at = ? WHERE id = 't-unapproved'").run(new Date().toISOString());
    }).toThrow(/CHECK constraint failed/);
  });

  it('approveTask sets approved_at, approved_by, preserves needs-review state, enqueues pr.create, and records human span', () => {
    const db = openDbConnection(dbPath);
    seedTask('t-approve', 'needs-review', 0); // verifier_exit_code = 0

    const updated = approveTask(db, 't-approve', humanAttr);
    expect(updated.state).toBe('needs-review');
    expect(updated.approved_at).toBeDefined();
    expect(updated.approved_by).toBe('human-operator:admin');

    // Verify pr.create job enqueued
    const jobs = db.prepare("SELECT * FROM bureau_jobs WHERE task_id = 't-approve' AND kind = 'pr.create'").all() as any[];
    expect(jobs).toHaveLength(1);

    // Verify journal span created
    const humanSpans = db.prepare("SELECT * FROM bureau_journal WHERE task_id = 't-approve' AND kind = 'human'").all() as any[];
    expect(humanSpans).toHaveLength(1);
    expect(humanSpans[0].kind).toBe('human');
    expect(humanSpans[0].actor_role).toBe('human-operator');
  });

  it('approveTask is idempotent on re-approval', () => {
    const db = openDbConnection(dbPath);
    seedTask('t-dbl-approve', 'needs-review', 0);

    const first = approveTask(db, 't-dbl-approve', humanAttr);
    expect(first.approved_at).toBeDefined();

    const second = approveTask(db, 't-dbl-approve', humanAttr);
    expect(second.approved_at).toEqual(first.approved_at);

    // Verify only 1 pr.create job enqueued (no duplicate enqueue on re-approval)
    const jobs = db.prepare("SELECT * FROM bureau_jobs WHERE task_id = 't-dbl-approve' AND kind = 'pr.create'").all() as any[];
    expect(jobs).toHaveLength(1);
  });
});
