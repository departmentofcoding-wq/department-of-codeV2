import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { pollUntil } from '../helpers/wait.ts';
import { setBackupProviderOverride, type BackupProvider } from '../../engine/contract/backup-seam.ts';
import { enqueueJob, reapExpiredJobs } from '../../engine/jobs/jobs.ts';
import { Runner, runnerConfigSchema } from '../../runner/main.ts';
import type { DbConnection, BureauJobRow } from '../../engine/contract/types.ts';

/**
 * The duplicate-execution regression (2026-08-28 incident, journal #790–#812).
 *
 * A job whose handler awaits a multi-second subprocess (gh pr create ≈ 6s,
 * git push over network) MUST keep the runner's event loop free so the 1s
 * heartbeat renews the job lease. When the providers used execFileSync the
 * loop froze for the whole subprocess, the (then 5s) lease expired, a second
 * runner reaped + re-claimed the job, and BOTH executed it — the zombie
 * pr.create collisions and dead backup.push rows in the live DB.
 *
 * This test rebuilds the exact conditions with a deliberately tight lease
 * (200ms) and a slow ASYNC provider (600ms), while a simulated second runner
 * reaps on every tick. Pass = the job completes done, is never reaped, and the
 * event loop demonstrably stayed alive (timer ticks observed during the run).
 */

let db: DbConnection & { close: () => void };
let dir: string;
let runner: Runner;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'async-prov-'));
  db = createRealSqliteDb(path.join(dir, 'bureau.db'));
});

afterEach(async () => {
  if (runner) await runner.stop();
  setBackupProviderOverride(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('async providers keep the lease alive under a slow subprocess', () => {
  it('a 600ms async backup.push survives a 2s lease window with a live reaper ticking', async () => {
    const tip = 'a'.repeat(40);
    const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
    setBackupProviderOverride({
      getLocalTip: async () => {
        await delay(200);
        return tip;
      },
      push: async () => {
        await delay(600);
      },
      getRemoteTip: async () => tip
    });

    // Lease 2000ms with heartbeat 25ms keeps the production 30:1 lease-to-
    // heartbeat ratio, so the property under test (heartbeats renew while the
    // handler awaits a subprocess) is exercised without racing wall clocks
    // against CPU starvation under the parallel suite (the A4 lesson: no
    // wall-clock-tight assertions under load).
    runner = new Runner(db, { BUREAU_LEASE_MS: 2000, BUREAU_HEARTBEAT_MS: 25, BUREAU_POLL_MS: 25 });
    runner.start();

    const job = enqueueJob(db, { kind: 'backup.push', payload: { target: 'origin/main' } });

    // The loop must stay free: count timer ticks while the handler runs.
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 25);

    // Simulate the second runner's reaper on every loop turn — with the old
    // sync providers (or a dead heartbeat) this flips the job to pending
    // mid-run once the lease window lapses.
    let reapedTotal = 0;
    const reaper = setInterval(() => {
      reapedTotal += reapExpiredJobs(db).length;
    }, 250);

    await pollUntil(
      () => db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', job.id)?.state === 'done',
      { timeoutMs: 15000, intervalMs: 25 }
    );

    clearInterval(ticker);
    clearInterval(reaper);

    const final = db.get<{ state: string; reaped_count: number; attempts: number }>(
      'SELECT state, reaped_count, attempts FROM bureau_jobs WHERE id = ?',
      job.id
    );
    expect(final?.state).toBe('done');
    expect(final?.reaped_count).toBe(0);
    expect(reapedTotal).toBe(0);
    // The handler took ~800ms total; at 25ms ticks a FREE loop records ~30
    // (threshold 12 leaves starvation headroom). A frozen loop (execFileSync)
    // records ~0 — the sync-detection half of the guard.
    expect(ticks).toBeGreaterThanOrEqual(12);
  });
});

describe('lease default has real headroom', () => {
  it('BUREAU_LEASE_MS defaults to 30000 (was 5000 — the duplicate-execution window)', () => {
    expect(runnerConfigSchema.parse({}).BUREAU_LEASE_MS).toBe(30000);
  });
});

describe('the REAL ExecGitBackupProvider yields the event loop during git', () => {
  it('timer callbacks fire while a real `git rev-parse` subprocess runs (async conversion proof)', async () => {
    const { execSync } = await import('node:child_process');
    const { ExecGitBackupProvider } = await import('../../engine/durability/git_backup_provider.ts');

    const repoDir = path.join(dir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init -q -b main', { cwd: repoDir });
    execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repoDir });

    const provider = new ExecGitBackupProvider(repoDir);

    // Several real subprocesses (~15-40ms each on Windows) so a FREE loop
    // accumulates a comfortable tick count; a frozen loop stays at exactly 0.
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 5);
    let tip = '';
    for (let i = 0; i < 5; i++) {
      tip = await provider.getLocalTip('main');
    }
    clearInterval(ticker);

    expect(tip).toMatch(/^[0-9a-f]{40}$/);
    // With execFileSync (the pre-fix code) the loop is frozen for every
    // subprocess and this number is 0 — this is the mutation M-ASYNC-1
    // detector. Five async spawns at ≥15ms each must leave ≥6 ticks at 5ms.
    expect(ticks).toBeGreaterThanOrEqual(6);
  });
});
