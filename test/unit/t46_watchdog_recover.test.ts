import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauTaskRow, BureauWatchdogFindingRow, DbConnection, JobContext } from '../../engine/contract/types.ts';
import { openDbConnection } from '../../engine/db/adapter.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { FINDING_CLASS_DEADLETTER_RETRIES_REMAINING, FINDING_CLASS_EXPIRED_LEASE_UNREAPED, FINDING_CLASS_VERIFYING_NO_VERIFY_RUN } from '../../engine/watchdog/constants.ts';
import { handleWatchdogRecover } from '../../engine/watchdog/recover.ts';

describe('T46 — Watchdog Recovery (watchdog.recover)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t46-test-'));
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

  it('1. Performs single recovery action for verifying_no_verify_run: enqueues verify.run, stamps recovery_job_id, updates budgets', async () => {
    const taskId = 'task-rec-1';
    const findingId = 'finding-rec-1';
    const recoverJobId = 'job-watchdog-recover-1';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Task Rec 1', 'verifying', 'work-r1', ?, ?)`,
      taskId,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_watchdog_findings (id, task_id, subject_kind, subject_id, finding_class, status, recover_attempts, detected_at)
       VALUES (?, ?, 'task', ?, ?, 'detected', 0, ?)`,
      findingId,
      taskId,
      taskId,
      FINDING_CLASS_VERIFYING_NO_VERIFY_RUN,
      now
    );

    const jobRow = enqueueJob(db, {
      id: recoverJobId,
      kind: 'watchdog.recover',
      task_id: taskId,
      payload: { findingId }
    });

    const mockCtx: JobContext = {
      db,
      job: jobRow,
      payload: { findingId },
      signal: new AbortController().signal
    };

    await handleWatchdogRecover(mockCtx);

    const updatedFinding = db.get<BureauWatchdogFindingRow>(`SELECT * FROM bureau_watchdog_findings WHERE id = ?`, findingId)!;
    expect(updatedFinding.recovery_job_id).toBe(recoverJobId);
    expect(updatedFinding.recover_attempts).toBe(1);
    expect(updatedFinding.status).toBe('recovering');

    const updatedTask = db.get<BureauTaskRow>(`SELECT * FROM bureau_tasks WHERE id = ?`, taskId)!;
    expect(updatedTask.recover_attempts).toBe(1);

    const enqueuedVerifyJob = db.get<BureauJobRow>(`SELECT * FROM bureau_jobs WHERE kind = 'verify.run' AND task_id = ?`, taskId);
    expect(enqueuedVerifyJob).toBeDefined();
    expect(enqueuedVerifyJob?.state).toBe('pending');
  });

  it('2. Performs single recovery action for expired_lease_unreaped: enqueues lease.reap job', async () => {
    const findingId = 'finding-rec-2';
    const recoverJobId = 'job-watchdog-recover-2';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_watchdog_findings (id, task_id, subject_kind, subject_id, finding_class, status, recover_attempts, detected_at)
       VALUES (?, NULL, 'lease', 'lease-123', ?, 'detected', 0, ?)`,
      findingId,
      FINDING_CLASS_EXPIRED_LEASE_UNREAPED,
      now
    );

    const jobRow = enqueueJob(db, {
      id: recoverJobId,
      kind: 'watchdog.recover',
      payload: { findingId }
    });

    const mockCtx: JobContext = {
      db,
      job: jobRow,
      payload: { findingId },
      signal: new AbortController().signal
    };

    await handleWatchdogRecover(mockCtx);

    const updatedFinding = db.get<BureauWatchdogFindingRow>(`SELECT * FROM bureau_watchdog_findings WHERE id = ?`, findingId)!;
    expect(updatedFinding.recovery_job_id).toBe(recoverJobId);
    expect(updatedFinding.recover_attempts).toBe(1);

    const enqueuedReapJob = db.get<BureauJobRow>(`SELECT * FROM bureau_jobs WHERE kind = 'lease.reap'`);
    expect(enqueuedReapJob).toBeDefined();
  });

  it('3. Performs single recovery action for deadletter_retries_remaining: notifies operator and marks resolved', async () => {
    const findingId = 'finding-rec-3';
    const recoverJobId = 'job-watchdog-recover-3';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_watchdog_findings (id, task_id, subject_kind, subject_id, finding_class, status, recover_attempts, detected_at)
       VALUES (?, NULL, 'job', 'job-dead-1', ?, 'detected', 0, ?)`,
      findingId,
      FINDING_CLASS_DEADLETTER_RETRIES_REMAINING,
      now
    );

    const jobRow = enqueueJob(db, {
      id: recoverJobId,
      kind: 'watchdog.recover',
      payload: { findingId }
    });

    const mockCtx: JobContext = {
      db,
      job: jobRow,
      payload: { findingId },
      signal: new AbortController().signal
    };

    await handleWatchdogRecover(mockCtx);

    const updatedFinding = db.get<BureauWatchdogFindingRow>(`SELECT * FROM bureau_watchdog_findings WHERE id = ?`, findingId)!;
    expect(updatedFinding.status).toBe('resolved');
    expect(updatedFinding.recover_attempts).toBe(1);
  });

  it('4. Budget Ceiling Enforcement: halts runaway recovery loop when recover_attempts >= ceiling', async () => {
    const taskId = 'task-runaway';
    const findingId = 'finding-runaway-1';
    const recoverJobId = 'job-watchdog-recover-halt';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES (?, 'Runaway Task', 'verifying', 'work-runaway', ?, ?)`,
      taskId,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_watchdog_findings (id, task_id, subject_kind, subject_id, finding_class, status, recover_attempts, detected_at)
       VALUES (?, ?, 'task', ?, ?, 'detected', 3, ?)`,
      findingId,
      taskId,
      taskId,
      FINDING_CLASS_VERIFYING_NO_VERIFY_RUN,
      now
    );

    const jobRow = enqueueJob(db, {
      id: recoverJobId,
      kind: 'watchdog.recover',
      task_id: taskId,
      payload: { findingId }
    });

    const mockCtx: JobContext = {
      db,
      job: jobRow,
      payload: { findingId },
      signal: new AbortController().signal
    };

    await handleWatchdogRecover(mockCtx);

    const updatedFinding = db.get<BureauWatchdogFindingRow>(`SELECT * FROM bureau_watchdog_findings WHERE id = ?`, findingId)!;
    expect(updatedFinding.status).toBe('failed');

    const verifyRunJob = db.get<BureauJobRow>(`SELECT * FROM bureau_jobs WHERE kind = 'verify.run' AND task_id = ?`, taskId);
    expect(verifyRunJob).toBeUndefined();
  });
});
