import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { Runner } from '../../runner/main.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t5-'));
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

describe.each(testImplementations)('T5: Two Runners Integration Test ($name)', ({ create }) => {
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

  it('claims and executes every job exactly once across two concurrent runners', async () => {
    // Ten jobs, not one: a single job can only prove one runner idled. Ten
    // proves the claim predicate partitions work under contention.
    const jobIds = Array.from({ length: 10 }, () =>
      enqueueJob(db, { kind: 'demo.sleep', payload: { ms: 20 } }).id
    );

    const runner1 = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000 });
    const runner2 = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000 });

    runner1.start();
    runner2.start();

    await new Promise((res) => setTimeout(res, 500));

    await runner1.stop();
    await runner2.stop();

    let totalClaims = 0;
    for (const jobId of jobIds) {
      const finalJob = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);
      expect(finalJob?.state).toBe('done');

      const claimSpans = db
        .all<BureauJournalRow>('SELECT * FROM bureau_journal WHERE job_id = ?', jobId)
        .filter((j) => j.detail.includes('"action":"claim"'));

      expect(claimSpans).toHaveLength(1);
      totalClaims += claimSpans.length;
    }
    expect(totalClaims).toBe(10);
  });
});
