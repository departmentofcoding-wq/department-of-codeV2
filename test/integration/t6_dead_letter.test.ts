import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BureauJobRow, DbConnection } from '../../engine/contract/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { Runner } from '../../runner/main.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t6-'));
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

describe.each(testImplementations)('T6: Dead Letter & Backoff Integration Test ($name)', ({ create }) => {
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

  it('retries with growing exponential backoff, transitions to dead, and calls notifyOperator exactly once', async () => {
    const notifySpy = vi.fn();
    const notifier = { notifyOperator: notifySpy };

    const job = enqueueJob(db, {
      kind: 'demo.fail',
      payload: { message: 'Expected test error' },
      max_attempts: 3
    });

    const runner = new Runner(
      db,
      {
        BUREAU_POLL_MS: 10,
        BUREAU_LEASE_MS: 5000
      },
      notifier
    );

    runner.start();

    // Observe without interfering: each time a retry is scheduled, record the
    // run_after the code actually wrote. The backoff schedule (100 * 2^attempts)
    // is short enough that natural timing finishes in well under a second —
    // erasing run_after to "speed things up" would destroy the very thing
    // under test.
    const observedRunAfters: string[] = [];
    let lastAttempts = 0;
    let current: BureauJobRow | undefined;

    for (let i = 0; i < 200; i++) {
      current = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', job.id);
      if (current && current.attempts !== lastAttempts) {
        lastAttempts = current.attempts;
        // Only a scheduled retry counts as a backoff observation: the dead
        // row carries no run_after, and anything else is not a retry.
        if (current.state === 'pending' && current.run_after) {
          observedRunAfters.push(current.run_after);
        }
      }
      if (current?.state === 'dead') break;
      await new Promise((res) => setTimeout(res, 10));
    }

    await runner.stop();

    const finalJob = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', job.id);
    expect(finalJob?.state).toBe('dead');
    expect(finalJob?.attempts).toBe(3);
    expect(finalJob?.last_error).toContain('Expected test error');

    // The backoff actually grew: consecutive run_after values strictly
    // increase, and by at least the 100ms base step of the schedule.
    expect(observedRunAfters.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < observedRunAfters.length; i++) {
      const previous = Date.parse(observedRunAfters[i - 1]);
      const currentAfter = Date.parse(observedRunAfters[i]);
      expect(currentAfter).toBeGreaterThan(previous);
      expect(currentAfter - previous).toBeGreaterThanOrEqual(100);
    }

    // Assert notifyOperator called exactly once
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith(job.id, expect.stringContaining('Terminal failure'));
  });
});
