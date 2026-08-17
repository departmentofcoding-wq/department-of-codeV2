import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import {
  claimJob,
  completeJob,
  enqueueJob,
  enqueueJobIfAbsent,
  failJob,
  heartbeatJob,
  reapExpiredJobs
} from '../../engine/jobs/jobs.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-'));
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

describe.each(testImplementations)('engine/jobs ($name)', ({ create }) => {
  let db: DbConnection;
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('enqueueJob creates a pending job and a system journal span', () => {
    const job = enqueueJob(db, {
      kind: 'demo.sleep',
      payload: { ms: 100 }
    });

    expect(job.id).toBeDefined();
    expect(job.state).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.max_attempts).toBe(3);

    const journal = db.all<BureauJournalRow>('SELECT * FROM bureau_journal WHERE job_id = ?', [job.id]);
    expect(journal).toHaveLength(1);
    expect(journal[0].kind).toBe('system');
    expect(journal[0].actor_role).toBe('foreman');
  });

  it('enqueueJobIfAbsent ignores duplicate IDs and enqueues once', () => {
    const customId = 'fixed-job-id-1';
    const first = enqueueJobIfAbsent(db, {
      id: customId,
      kind: 'demo.sleep',
      payload: { ms: 50 }
    });
    expect(first.inserted).toBe(true);
    expect(first.job.id).toBe(customId);

    const second = enqueueJobIfAbsent(db, {
      id: customId,
      kind: 'demo.sleep',
      payload: { ms: 100 }
    });
    expect(second.inserted).toBe(false);
    expect(second.job.id).toBe(customId);

    const journal = db.all<BureauJournalRow>('SELECT * FROM bureau_journal WHERE job_id = ?', [customId]);
    expect(journal).toHaveLength(1);
  });

  it('claimJob claims pending jobs in FIFO order and updates lease', async () => {
    const job1 = enqueueJob(db, { kind: 'demo.sleep', payload: { id: 1 } });
    await new Promise((res) => setTimeout(res, 5));
    const job2 = enqueueJob(db, { kind: 'demo.sleep', payload: { id: 2 } });

    const claimed1 = claimJob(db, 'runner-a', 5000);
    expect(claimed1).not.toBeNull();
    expect(claimed1?.id).toBe(job1.id);
    expect(claimed1?.state).toBe('running');
    expect(claimed1?.lease_owner).toBe('runner-a');

    const claimed2 = claimJob(db, 'runner-b', 5000);
    expect(claimed2).not.toBeNull();
    expect(claimed2?.id).toBe(job2.id);

    const claimed3 = claimJob(db, 'runner-a', 5000);
    expect(claimed3).toBeNull();
  });

  it('claimJob handles run_after IS NULL predicate and ignores future run_after', () => {
    const futureIso = new Date(Date.now() + 100000).toISOString();
    enqueueJob(db, { kind: 'demo.sleep', run_after: futureIso });

    const claimed = claimJob(db, 'runner-a', 5000);
    expect(claimed).toBeNull();
  });

  it('heartbeatJob extends lease for running owner and guards against wrong owner', () => {
    const job = enqueueJob(db, { kind: 'demo.sleep' });
    const claimed = claimJob(db, 'runner-a', 1000);

    const extended = heartbeatJob(db, job.id, 'runner-a', 5000);
    expect(extended).toBe(true);

    const wrongOwner = heartbeatJob(db, job.id, 'runner-b', 5000);
    expect(wrongOwner).toBe(false);
  });

  it('completeJob transitions state to done and records finished_at', () => {
    const job = enqueueJob(db, { kind: 'demo.sleep' });
    claimJob(db, 'runner-a', 5000);

    completeJob(db, job.id, { result: 'ok' });

    const updated = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', [job.id]);
    expect(updated?.state).toBe('done');
    expect(updated?.finished_at).not.toBeNull();
    expect(updated?.lease_owner).toBeNull();

    const journal = db.all<BureauJournalRow>('SELECT * FROM bureau_journal WHERE job_id = ?', [job.id]);
    expect(journal.some((j) => j.detail.includes('complete'))).toBe(true);
  });

  it('failJob increments attempts, truncates error, and backs off until max attempts', () => {
    const job = enqueueJob(db, { kind: 'demo.fail', max_attempts: 2 });
    claimJob(db, 'runner-a', 5000);

    const longError = 'x'.repeat(3000);
    const fail1 = failJob(db, job.id, longError, 1000);
    expect(fail1.terminal).toBe(false);
    expect(fail1.job.attempts).toBe(1);
    expect(fail1.job.state).toBe('pending');
    expect(fail1.job.last_error?.length).toBe(2000);
    expect(fail1.job.run_after).not.toBeNull();

    // Re-claim and fail again -> terminal dead
    claimJob(db, 'runner-a', 5000);
    const fail2 = failJob(db, job.id, 'Second failure', 1000);
    expect(fail2.terminal).toBe(true);
    expect(fail2.job.attempts).toBe(2);
    expect(fail2.job.state).toBe('dead');
    // A dead job has no scheduled retry: a stale run_after would be a lie.
    expect(fail2.job.run_after).toBeNull();
  });

  it('job spans backfill work_uuid and work_title through the one journal door', () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, work_uuid, work_title, created_at, updated_at)
       VALUES ('task-j1', 'Journal door task', 'work-j1', 'Journal Door Session', ?, ?)`,
      now,
      now
    );

    const job = enqueueJob(db, { kind: 'demo.sleep', task_id: 'task-j1' });
    const spans = db.all<BureauJournalRow>('SELECT * FROM bureau_journal WHERE job_id = ?', job.id);

    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.work_uuid).toBe('work-j1');
      expect(span.work_title).toBe('Journal Door Session');
      expect(span.actor_role).toBe('foreman');
      expect(span.provider).toBe('deterministic');
    }
  });

  it('reapExpiredJobs resets expired running leases to pending and bumps reaped_count', async () => {
    const job = enqueueJob(db, { kind: 'demo.sleep' });
    // Claim with 1ms lease
    claimJob(db, 'runner-a', 1);

    await new Promise((res) => setTimeout(res, 50));

    const reaped = reapExpiredJobs(db);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].id).toBe(job.id);
    expect(reaped[0].reaped_count).toBe(1);
    expect(reaped[0].state).toBe('pending');

    const journal = db.all<BureauJournalRow>('SELECT * FROM bureau_journal WHERE job_id = ?', [job.id]);
    expect(journal.some((j) => j.detail.includes('lease-reaped'))).toBe(true);
  });
});
