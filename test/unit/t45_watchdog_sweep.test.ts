import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauTaskRow, BureauWatchdogFindingRow, DbConnection } from '../../engine/contract/types.ts';
import { openDbConnection } from '../../engine/db/adapter.ts';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';
import {
  FINDING_CLASS_DEADLETTER_RETRIES_REMAINING,
  FINDING_CLASS_DISPATCH_NO_LIVE_LEASE,
  FINDING_CLASS_EXPIRED_LEASE_UNREAPED,
  FINDING_CLASS_VERIFYING_NO_VERIFY_RUN
} from '../../engine/watchdog/constants.ts';
import {
  detectWatchdogFindings
} from '../../engine/watchdog/sweep.ts';

describe('T45 — Watchdog Detection (watchdog.sweep)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t45-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDbConnection(dbPath);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('1. Schema & Index Migration: fresh DB has added columns and unique index', () => {
    const rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);
    applyBootMigrations(rawDb);

    const cols = rawDb.prepare('PRAGMA table_info(bureau_watchdog_findings)').all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));

    expect(colNames.has('subject_kind')).toBe(true);
    expect(colNames.has('subject_id')).toBe(true);
    expect(colNames.has('recover_attempts')).toBe(true);

    const indexList = rawDb.prepare('PRAGMA index_list(bureau_watchdog_findings)').all() as Array<{ name: string }>;
    const hasActiveIndex = indexList.some(i => i.name === 'idx_watchdog_findings_subject_active');
    expect(hasActiveIndex).toBe(true);

    rawDb.close();
  });

  it('2. Detects verifying_no_verify_run (Class 1)', () => {
    const taskId = 'task-stranded-verifying';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Stranded Task', 'verifying', 'work-1', ?, ?)`,
      taskId,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
       VALUES ('job-completed-1', 'worktree.prepare', ?, 'done', ?)`,
      taskId,
      now
    );

    const findings = detectWatchdogFindings(db);
    expect(findings.length).toBe(1);
    expect(findings[0].finding_class).toBe(FINDING_CLASS_VERIFYING_NO_VERIFY_RUN);
    expect(findings[0].subject_kind).toBe('task');
    expect(findings[0].subject_id).toBe(taskId);
    expect(findings[0].task_id).toBe(taskId);
    expect(findings[0].status).toBe('detected');
  });

  it('3. Detects expired_lease_unreaped (Class 2)', () => {
    const leaseId = 'lease-expired-1';
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('task-lease', 'Lease Task', 'claimed', 'work-2', ?, ?)`,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, created_at)
       VALUES ('dispatch-1', 'task-lease', 'work-2', 'junior-engineer', 'ollama', 'coder', 'running', ?)`,
      now
    );

    db.run(
      `INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, actor_role, provider, model, created_at, updated_at)
       VALUES (?, 'win-1', 'dispatch-1', 'active', ?, ?, 'junior-engineer', 'ollama', 'coder', ?, ?)`,
      leaseId,
      pastTime,
      pastTime,
      pastTime,
      pastTime
    );

    const findings = detectWatchdogFindings(db);
    const leaseFinding = findings.find(f => f.finding_class === FINDING_CLASS_EXPIRED_LEASE_UNREAPED);
    expect(leaseFinding).toBeDefined();
    expect(leaseFinding?.subject_kind).toBe('lease');
    expect(leaseFinding?.subject_id).toBe(leaseId);
  });

  it('4. Detects deadletter_retries_remaining (Class 3)', () => {
    const deadJobId = 'job-deadletter-1';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_jobs (id, kind, state, attempts, max_attempts, created_at)
       VALUES (?, 'demo.fail', 'dead', 1, 3, ?)`,
      deadJobId,
      now
    );

    const findings = detectWatchdogFindings(db);
    const deadFinding = findings.find(f => f.finding_class === FINDING_CLASS_DEADLETTER_RETRIES_REMAINING);
    expect(deadFinding).toBeDefined();
    expect(deadFinding?.subject_kind).toBe('job');
    expect(deadFinding?.subject_id).toBe(deadJobId);
  });

  it('5. Detects dispatch_no_live_lease (Class 4)', () => {
    const dispatchId = 'dispatch-no-lease-1';
    const taskId = 'task-dispatch-1';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Dispatch Task', 'claimed', 'work-4', ?, ?)`,
      taskId,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, created_at)
       VALUES (?, ?, 'work-4', 'junior-engineer', 'ollama', 'coder', 'running', ?)`,
      dispatchId,
      taskId,
      now
    );

    const findings = detectWatchdogFindings(db);
    const dispatchFinding = findings.find(f => f.finding_class === FINDING_CLASS_DISPATCH_NO_LIVE_LEASE);
    expect(dispatchFinding).toBeDefined();
    expect(dispatchFinding?.subject_kind).toBe('dispatch');
    expect(dispatchFinding?.subject_id).toBe(dispatchId);
  });

  it('6. Idempotency & Unique Index: second sweep on same state produces zero duplicate active findings', () => {
    const taskId = 'task-idempotent';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Idempotent Task', 'verifying', 'work-6', ?, ?)`,
      taskId,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
       VALUES ('job-comp-6', 'worktree.prepare', ?, 'done', ?)`,
      taskId,
      now
    );

    const firstFindings = detectWatchdogFindings(db);
    expect(firstFindings.length).toBe(1);

    const secondFindings = detectWatchdogFindings(db);
    expect(secondFindings.length).toBe(0);

    const totalInDb = db.all<BureauWatchdogFindingRow>(`SELECT * FROM bureau_watchdog_findings`);
    expect(totalInDb.length).toBe(1);
  });

  it('7. Read-Only Proof: sweeps snapshot bureau_tasks and non-watchdog bureau_jobs before and after sweep with zero mutations', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('task-ro-1', 'Read Only Task 1', 'verifying', 'work-ro-1', ?, ?)`,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('task-ro-2', 'Read Only Task 2', 'claimed', 'work-ro-2', ?, ?)`,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
       VALUES ('job-ro-1', 'worktree.prepare', 'task-ro-1', 'done', ?)`,
      now
    );

    db.run(
      `INSERT INTO bureau_jobs (id, kind, state, attempts, max_attempts, created_at)
       VALUES ('job-ro-2', 'demo.fail', 'dead', 1, 3, ?)`,
      now
    );

    const tasksBefore = db.all<BureauTaskRow>(`SELECT * FROM bureau_tasks ORDER BY id ASC`);
    const jobsBefore = db.all<BureauJobRow>(`SELECT * FROM bureau_jobs WHERE kind NOT LIKE 'watchdog.%' ORDER BY id ASC`);

    detectWatchdogFindings(db);

    const tasksAfter = db.all<BureauTaskRow>(`SELECT * FROM bureau_tasks ORDER BY id ASC`);
    const jobsAfter = db.all<BureauJobRow>(`SELECT * FROM bureau_jobs WHERE kind NOT LIKE 'watchdog.%' ORDER BY id ASC`);

    expect(tasksAfter).toEqual(tasksBefore);
    expect(jobsAfter).toEqual(jobsBefore);
  });
});
