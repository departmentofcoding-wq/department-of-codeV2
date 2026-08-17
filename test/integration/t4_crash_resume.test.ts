import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { enqueueJob, reapExpiredJobs } from '../../engine/jobs/jobs.ts';
import { Runner } from '../../runner/main.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t4-'));
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

/**
 * T4a — fast in-process leg. The "crash" is simulated by halting the runner's
 * loops without the graceful path. The real process-death leg lives in T4b
 * below; this one exists to run the same resume assertions against both
 * database implementations quickly.
 */
describe.each(testImplementations)('T4a: Crash-Resume, simulated halt ($name)', ({ create }) => {
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

  it('resumes execution after crash without duplicating child jobs', async () => {
    // 1. Enqueue demo.chain parent job
    const parentJob = enqueueJob(db, {
      id: 'parent-chain-1',
      kind: 'demo.chain',
      payload: { count: 3, ms: 500 }
    });

    // 2. Start Runner 1 with short lease (150ms)
    const runner1 = new Runner(db, {
      BUREAU_POLL_MS: 10,
      BUREAU_LEASE_MS: 150,
      BUREAU_HEARTBEAT_MS: 1000 // Disable fast heartbeat so lease expires
    });

    runner1.start();

    // Wait until child jobs are enqueued and at least one is in 'running' state
    let runningChild: BureauJobRow | undefined;
    for (let i = 0; i < 50; i++) {
      const jobs = db.all<BureauJobRow>('SELECT * FROM bureau_jobs');
      runningChild = jobs.find((j) => j.id.startsWith('parent-chain-1:sleep:') && j.state === 'running');
      if (runningChild) break;
      await new Promise((res) => setTimeout(res, 10));
    }

    expect(runningChild).toBeDefined();

    // 3. Simulate hard crash of Runner 1 (halt poll & heartbeat loops instantly mid-job)
    (runner1 as any).isStopping = true;
    if ((runner1 as any).pollTimer) clearTimeout((runner1 as any).pollTimer);
    if ((runner1 as any).heartbeatTimer) clearInterval((runner1 as any).heartbeatTimer);

    // Verify children were enqueued by parent
    const childrenBeforeReap = db.all<BureauJobRow>(
      `SELECT * FROM bureau_jobs WHERE id LIKE 'parent-chain-1:sleep:%'`
    );
    expect(childrenBeforeReap.length).toBe(3);

    // Wait for lease of running child to expire
    await new Promise((res) => setTimeout(res, 200));

    // Reap expired lease (simulating watchdog/runner 2 startup reap)
    const reaped = reapExpiredJobs(db);
    expect(reaped.length).toBeGreaterThan(0);
    expect(reaped.some((j) => j.id === runningChild?.id)).toBe(true);

    // 4. Start Runner 2 to resume execution with short sleep payloads for quick finish
    db.run(
      `UPDATE bureau_jobs SET payload = ? WHERE id LIKE 'parent-chain-1:sleep:%' AND state != 'done'`,
      JSON.stringify({ ms: 20 })
    );

    const runner2 = new Runner(db, {
      BUREAU_POLL_MS: 10,
      BUREAU_LEASE_MS: 1000,
      BUREAU_HEARTBEAT_MS: 100
    });

    runner2.start();

    // Wait for runner2 to complete remaining jobs
    await new Promise((res) => setTimeout(res, 300));
    await runner2.stop();

    // 5. Assert exact total of 3 child jobs (never 6)
    const allJobs = db.all<BureauJobRow>('SELECT * FROM bureau_jobs');
    const childJobs = allJobs.filter((j) => j.id.startsWith('parent-chain-1:sleep:'));
    expect(childJobs).toHaveLength(3);

    for (const child of childJobs) {
      expect(child.state).toBe('done');
    }

    const parentFinal = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', parentJob.id);
    expect(parentFinal?.state).toBe('done');

    // Assert lease-reaped journal span exists
    const journal = db.all<BureauJournalRow>('SELECT * FROM bureau_journal');
    expect(journal.some((j) => j.detail.includes('lease-reaped'))).toBe(true);
  });
});

/**
 * T4b — the leg the phase exit criterion is named for: a REAL runner process
 * is killed hard mid-job (taskkill /T /F on Windows, SIGKILL elsewhere — no
 * cleared timers, no graceful path), and a fresh process resumes the work
 * exactly once through the real boot door.
 */
describe('T4b: Crash-Resume — hard process kill (real node:sqlite)', () => {
  it('a killed runner process is reaped and resumed exactly-once by a fresh process', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t4b-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const testDb = createRealSqliteDb(dbPath);

    const killTree = (pid: number | undefined) => {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
      } else if (pid !== undefined) {
        process.kill(pid, 'SIGKILL');
      }
    };

    try {
      enqueueJob(testDb, { id: 'kill-chain-1', kind: 'demo.chain', payload: { count: 3, ms: 800 } });

      const childEnv = {
        ...process.env,
        BUREAU_DB_PATH: dbPath,
        BUREAU_POLL_MS: '10',
        BUREAU_LEASE_MS: '500',
        BUREAU_HEARTBEAT_MS: '100'
      };
      const spawnChild = () =>
        spawn(process.execPath, ['--experimental-strip-types', path.join(repoRoot, 'runner', 'main.ts')], {
          cwd: repoRoot,
          env: childEnv,
          stdio: 'ignore'
        });

      // Runner process 1
      const child1 = spawnChild();

      let runningChild: BureauJobRow | undefined;
      for (let i = 0; i < 1500 && runningChild === undefined; i++) {
        const jobs = testDb.all<BureauJobRow>('SELECT * FROM bureau_jobs');
        runningChild = jobs.find((j) => j.id.startsWith('kill-chain-1:sleep:') && j.state === 'running');
        if (!runningChild) await new Promise((res) => setTimeout(res, 10));
      }
      expect(runningChild).toBeDefined();

      // Hard kill mid-job
      killTree(child1.pid);
      await new Promise<void>((resolve) => child1.once('exit', () => resolve()));

      // Wait for runner 1's lease (500ms) to expire so the watchdog in
      // runner 2 will find an expired lease and journal 'lease-reaped'.
      await new Promise((res) => setTimeout(res, 600));

      // Shorten the remaining sleeps so the resumed run is quick
      testDb.run(
        `UPDATE bureau_jobs SET payload = ? WHERE id LIKE 'kill-chain-1:sleep:%' AND state != 'done'`,
        JSON.stringify({ ms: 20 })
      );

      const childEnv2 = {
        ...process.env,
        BUREAU_DB_PATH: dbPath,
        BUREAU_POLL_MS: '10',
        BUREAU_LEASE_MS: '10000',
        BUREAU_HEARTBEAT_MS: '500'
      };
      const spawnChild2 = () =>
        spawn(process.execPath, ['--experimental-strip-types', path.join(repoRoot, 'runner', 'main.ts')], {
          cwd: repoRoot,
          env: childEnv2,
          stdio: 'ignore'
        });

      // Runner process 2 resumes
      const child2 = spawnChild2();

      // Wait for the whole chain to finish: parent AND all children. Waiting
      // on the parent alone can stop child2 mid-child-job, and a job aborted
      // by shutdown is (correctly) a retry, not done.
      const allDone = () => {
        const jobs = testDb.all<BureauJobRow>('SELECT * FROM bureau_jobs');
        const parentNow = jobs.find((j) => j.id === 'kill-chain-1');
        const childrenNow = jobs.filter((j) => j.id.startsWith('kill-chain-1:sleep:'));
        return (
          parentNow?.state === 'done' &&
          childrenNow.length === 3 &&
          childrenNow.every((c) => c.state === 'done')
        );
      };

      // Under a busy test run (vitest parallel workers), spawning two Node
      // processes can cost several seconds — the budget must absorb that
      // overhead and still give the resumed chain time to finish.
      for (let i = 0; i < 3000; i++) {
        if (allDone()) break;
        await new Promise((res) => setTimeout(res, 10));
      }

      // Graceful stop, with a force-kill backstop if the signal is lost
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          try { killTree(child2.pid); } catch { /* already gone */ }
          resolve();
        }, 10000);
        child2.once('exit', () => { clearTimeout(force); resolve(); });
        child2.kill('SIGINT');
      });

      // Exactly once: parent done, exactly three children, all done
      const allJobsDebug = testDb.all<BureauJobRow>('SELECT * FROM bureau_jobs');
      if (allJobsDebug.some((j) => j.state !== 'done')) {
        console.error('T4b DEBUG - bureau_jobs:', JSON.stringify(allJobsDebug, null, 2));
        console.error(
          'T4b DEBUG - bureau_journal:',
          JSON.stringify(testDb.all('SELECT * FROM bureau_journal'), null, 2)
        );
      }

      const parent = testDb.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', ['kill-chain-1']);
      expect(parent?.state).toBe('done');

      const children = testDb.all<BureauJobRow>(
        `SELECT * FROM bureau_jobs WHERE id LIKE 'kill-chain-1:sleep:%'`
      );
      expect(children).toHaveLength(3);
      for (const child of children) {
        expect(child.state).toBe('done');
      }

      // The abandoned lease was reaped and journaled through the one door
      const spans = testDb.all<BureauJournalRow>(`SELECT * FROM bureau_journal WHERE job_id LIKE 'kill-chain-1%'`);
      expect(spans.some((j) => j.detail.includes('lease-reaped'))).toBe(true);
      // Every span is attributed: the record says who did the work
      for (const span of spans) {
        expect(span.actor_role).toBe('foreman');
        expect(span.provider).toBe('deterministic');
      }
    } finally {
      testDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
