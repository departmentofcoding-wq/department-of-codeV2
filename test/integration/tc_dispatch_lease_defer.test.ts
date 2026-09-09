import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { acquireLease, releaseLease } from '../../engine/harness/lease-manager.ts';
import { handleJuniorDispatch, MAX_DISPATCH_LEASE_DEFERS } from '../../engine/harness/dispatch-job.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import type { JobContext } from '../../engine/contract/index.ts';

/**
 * R5 — a dispatch WAITS for a contended window lease, and defers with backoff
 * instead of burning its attempts instantly.
 *
 * Scar (2026-09-08): both contended dispatches failed-fast on
 * "Window target 'window-B' is already leased" ×3 in ~1 second (the failJob
 * backoff was 100–200ms) while the sibling holding the lease would only free
 * it minutes later — terminal death → salvage → blocked task.
 */
describe('R5: dispatch lease acquisition waits and defers', () => {
  const ATTR = { actor_role: 'junior-engineer', provider: 'antigravity', model: 'test', account: null } as const;

  let prevWaitMs: string | undefined;

  beforeEach(() => {
    prevWaitMs = process.env['BUREAU_DISPATCH_LEASE_WAIT_MS'];
    process.env['BUREAU_DISPATCH_LEASE_WAIT_MS'] = '80';
  });

  afterEach(() => {
    if (prevWaitMs === undefined) {
      delete process.env['BUREAU_DISPATCH_LEASE_WAIT_MS'];
    } else {
      process.env['BUREAU_DISPATCH_LEASE_WAIT_MS'] = prevWaitMs;
    }
  });

  function seed(db: any, taskId: string, dispatchId: string, deferCount?: number) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'R5 defer', 'claimed', 1, 'w-r5', ?, ?)`,
      taskId, now, now
    );
    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, created_at)
       VALUES (?, ?, 'w-r5', 'junior-engineer', 'antigravity', 'unspecified', 'pending', ?)`,
      dispatchId, taskId, now
    );
    const job = enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: taskId,
      payload: {
        dispatchId,
        stage: 'junior-implementation',
        prompt: 'do the thing',
        junior: 'A',
        ...(deferCount !== undefined ? { deferCount } : {})
      },
      max_attempts: 1
    });
    const ctx: JobContext = { db, job, payload: JSON.parse(job.payload), signal: undefined } as any;
    return ctx;
  }

  it('a held window defers: dispatch back to pending, successor job with run_after backoff, NO attempt consumed', async () => {
    const db = createFakeDb();
    const holder = acquireLease(db, 'window-A', 'disp-holder', { ...ATTR });
    const ctx = seed(db, 'task-r5-defer', 'disp-r5-defer');

    await handleJuniorDispatch(ctx);

    // The dispatch row is parked pending again (not stuck 'running').
    const row = db.get<{ status: string }>(`SELECT status FROM bureau_dispatches WHERE id = 'disp-r5-defer'`);
    expect(row?.status).toBe('pending');

    // The successor defer job exists with a future run_after and the counter.
    const deferJob = db.get<{ id: string; state: string; run_after: string; payload: string }>(
      `SELECT * FROM bureau_jobs WHERE id = ?`,
      `junior.dispatch:defer:disp-r5-defer:1`
    );
    expect(deferJob).toBeTruthy();
    expect(deferJob!.state).toBe('pending');
    expect(deferJob!.run_after).not.toBeNull();
    expect(new Date(deferJob!.run_after!).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(JSON.parse(deferJob!.payload).deferCount).toBe(1);

    // The original job never failed — no attempts consumed by contention.
    const orig = db.get<{ attempts: number; state: string }>(`SELECT attempts, state FROM bureau_jobs WHERE id = ?`, ctx.job.id);
    expect(orig?.attempts).toBe(0);

    const span = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%dispatch_lease_deferred%'`
    );
    expect(span?.detail).toContain('window-A');

    releaseLease(db, holder.id);
  });

  it('past the defer ceiling the contention fails LOUD (LeaseError propagates, no further defer job)', async () => {
    const db = createFakeDb();
    const holder = acquireLease(db, 'window-A', 'disp-holder-2', { ...ATTR });
    const ctx = seed(db, 'task-r5-ceiling', 'disp-r5-ceiling', MAX_DISPATCH_LEASE_DEFERS);

    await expect(handleJuniorDispatch(ctx)).rejects.toThrow(/Timed out|already leased/);

    const deferJobs = db.all(
      `SELECT id FROM bureau_jobs WHERE id LIKE 'junior.dispatch:defer:disp-r5-ceiling:%'`
    );
    expect(deferJobs).toHaveLength(0);

    releaseLease(db, holder.id);
  });

  it('an uncontended window is acquired immediately (behavior unchanged from fail-fast when free)', async () => {
    const db = createFakeDb();
    const ctx = seed(db, 'task-r5-free', 'disp-r5-free');

    // The wait helper returns on the first poll when the window is free; the
    // dispatch then proceeds past acquisition. Point the antigravity seam at a
    // failing fake so the run aborts AFTER the lease was held — proof the
    // acquisition itself succeeded without deferring.
    const { setAntigravityDriverOverride } = await import('../../engine/harness/antigravity-seam.ts');
    setAntigravityDriverOverride({
      async runCommand() {
        throw new Error('post-acquisition abort');
      }
    } as any);
    try {
      await expect(handleJuniorDispatch(ctx)).rejects.toThrow('post-acquisition abort');
    } finally {
      setAntigravityDriverOverride(null);
    }

    const deferJobs = db.all(
      `SELECT id FROM bureau_jobs WHERE id LIKE 'junior.dispatch:defer:disp-r5-free:%'`
    );
    expect(deferJobs).toHaveLength(0);

    // The lease was acquired (and released on failure).
    const leases = db.all(`SELECT * FROM bureau_window_leases WHERE window_target = 'window-A'`);
    expect(leases.length).toBeGreaterThan(0);
    expect(leases.every((l: any) => l.status !== 'active')).toBe(true);
  });
});
