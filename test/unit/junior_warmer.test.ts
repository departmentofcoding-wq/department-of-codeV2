import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import type { DbConnection } from '../../engine/contract/index.ts';
import {
  JuniorWarmer,
  JUNIOR_WARMUP_DISABLED_KEY,
  WARM_RETRY_BACKOFF_MS
} from '../../engine/flow/junior-warmer.ts';
import { isJuniorHealthy, setJuniorUnhealthy } from '../../engine/flow/junior-health.ts';
import { Runner } from '../../runner/main.ts';
import { pollUntil } from '../helpers/wait.ts';

/**
 * Junior auto-warmup unit tests (docs/plan-junior-auto-warmup.md §6). All
 * harness boundaries are injected fakes — nothing here launches a real app or
 * touches the network.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function spansOf(db: DbConnection, action: string): Array<{ kind: string; detail: string }> {
  return db.all(
    `SELECT kind, detail FROM bureau_journal
     WHERE json_extract(detail, '$.action') = ? ORDER BY id`,
    action
  );
}

function insertQueuedTask(db: DbConnection, id: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, work_title,
       plan_rounds, verify_fixes, cycles, attempts, created_at, updated_at)
     VALUES (?, ?, 'queued', 1, ?, ?, 0, 0, 0, 0, ?, ?)`,
    id,
    `Task ${id}`,
    `work-${id}`,
    `Task ${id}`,
    now,
    now
  );
}

async function awaitSettled(warmer: JuniorWarmer, junior: string): Promise<void> {
  await pollUntil(() => !warmer.isInFlight(junior), { label: `warm for ${junior} settled` });
}

describe('JuniorWarmer (junior auto-warmup)', () => {
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('warms a cold junior: ensure -> probe readiness -> clears the admission cooldown, journals requested + succeeded (system spans)', async () => {
    // The admission probe-fail mark the warmer exists to answer (plan §4.1).
    setJuniorUnhealthy(db, 'A', 60_000, 'probe_failed');
    const ensure = vi.fn(async () => ({ launched: true, port: 9333 }));
    const probe = vi.fn(async () => true);
    const warmer = new JuniorWarmer(db, { ensure, probe, sleep: async () => {}, now: () => 0 });

    expect(warmer.request('A', 'probe_failed')).toBe(true);
    await awaitSettled(warmer, 'A');

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(isJuniorHealthy(db, 'A')).toBe(true);

    const requested = spansOf(db, 'junior_warmup_requested');
    expect(requested).toHaveLength(1);
    expect(requested[0].kind).toBe('system');
    expect(JSON.parse(requested[0].detail)).toEqual({
      action: 'junior_warmup_requested',
      junior: 'A',
      reason: 'probe_failed'
    });

    const succeeded = spansOf(db, 'junior_warmup_succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].kind).toBe('system');
    expect(JSON.parse(succeeded[0].detail)).toMatchObject({ junior: 'A', launched: true });
  });

  it('R1: success requires the ADMISSION PROBE to pass — ensure alone (probe never ready) is a failure, not a success', async () => {
    const ensure = vi.fn(async () => ({ launched: true, port: 9333 }));
    const probe = vi.fn(async () => false);
    const warmer = new JuniorWarmer(db, { ensure, probe, sleep: async () => {}, now: () => 0 });

    expect(warmer.request('A', 'boot')).toBe(true);
    await awaitSettled(warmer, 'A');

    // The readiness loop polled the full budget without the probe passing.
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(spansOf(db, 'junior_warmup_succeeded')).toHaveLength(0);
    const failed = spansOf(db, 'junior_warmup_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].kind).toBe('guardrail');
    expect(isJuniorHealthy(db, 'A')).toBe(false);
  });

  it('readiness can arrive late (probe flips after two failed polls) — success is declared only then', async () => {
    let calls = 0;
    const probe = vi.fn(async () => ++calls >= 3);
    const warmer = new JuniorWarmer(db, {
      ensure: async () => ({ launched: true, port: 9333 }),
      probe,
      sleep: async () => {},
      now: () => 0
    });

    expect(warmer.request('A', 'boot')).toBe(true);
    await awaitSettled(warmer, 'A');

    expect(probe).toHaveBeenCalledTimes(3);
    expect(spansOf(db, 'junior_warmup_succeeded')).toHaveLength(1);
    expect(spansOf(db, 'junior_warmup_failed')).toHaveLength(0);
  });

  it('a failed warm (ensure throws) journals a guardrail span, sets cooldown, and backs off — a re-request inside the backoff returns false, after it returns true', async () => {
    let fakeNow = 1_000_000;
    const ensure = vi.fn(async () => {
      throw new Error('Antigravity IDE executable not found. Set ANTIGRAVITY_IDE_PATH');
    });
    const warmer = new JuniorWarmer(db, {
      ensure,
      probe: async () => true,
      sleep: async () => {},
      now: () => fakeNow
    });

    expect(warmer.request('A', 'probe_failed')).toBe(true);
    await awaitSettled(warmer, 'A');

    const failed = spansOf(db, 'junior_warmup_failed');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0].detail).error).toContain('executable not found');
    expect(isJuniorHealthy(db, 'A')).toBe(false);

    // Inside the backoff window: refused, no new attempt.
    expect(warmer.request('A', 'probe_failed')).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);

    // Past the window (fake clock advanced): a fresh attempt starts.
    fakeNow += WARM_RETRY_BACKOFF_MS + 1;
    expect(warmer.request('A', 'probe_failed')).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(2);
    await awaitSettled(warmer, 'A');
  });

  it('dedupes: while a warm is in flight, further requests return true without a second ensure', async () => {
    const gate = deferred<void>();
    const ensure = vi.fn(
      () =>
        new Promise<{ launched: boolean; port: number }>(resolve => {
          void gate.promise.then(() => resolve({ launched: true, port: 9333 }));
        })
    );
    const warmer = new JuniorWarmer(db, { ensure, probe: async () => true, sleep: async () => {}, now: () => 0 });

    expect(warmer.request('A', 'boot')).toBe(true);
    expect(warmer.request('A', 'probe_failed')).toBe(true); // dedup hit, still "in flight"
    expect(warmer.request('A', 'boot')).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(warmer.isInFlight('A')).toBe(true);

    gate.resolve();
    await awaitSettled(warmer, 'A');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(spansOf(db, 'junior_warmup_succeeded')).toHaveLength(1);
  });

  it('the junior_warmup:disabled meta key is the operator off-switch: request returns false, nothing launches', async () => {
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JUNIOR_WARMUP_DISABLED_KEY
    );
    const ensure = vi.fn(async () => ({ launched: true, port: 9333 }));
    const warmer = new JuniorWarmer(db, { ensure, probe: async () => true, sleep: async () => {}, now: () => 0 });

    expect(warmer.request('A', 'boot')).toBe(false);
    expect(warmer.request('B', 'probe_failed')).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(spansOf(db, 'junior_warmup_requested')).toHaveLength(0);
  });

  it('Rec4 absolute cap: a HUNG ensure cannot pin the in-flight entry — the cap clears it and a fresh warm may start', async () => {
    const ensure = vi.fn(
      () =>
        new Promise<{ launched: boolean; port: number }>(() => {
          /* never settles — a wedged spawn */
        })
    );
    const warmer = new JuniorWarmer(db, {
      ensure,
      probe: async () => true,
      sleep: async () => {},
      now: () => 0
    }, { capMs: 25 });

    expect(warmer.request('A', 'boot')).toBe(true);
    expect(warmer.isInFlight('A')).toBe(true);

    await awaitSettled(warmer, 'A'); // the cap fired and the race chain cleaned up
    expect(ensure).toHaveBeenCalledTimes(1);

    // A fresh request is accepted immediately (the hung attempt cannot hold the junior hostage).
    expect(warmer.request('A', 'boot')).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(2);
    await awaitSettled(warmer, 'A');
  });

  it('an unknown junior id is refused loudly-but-safely: false, no throw, no span', async () => {
    const ensure = vi.fn(async () => ({ launched: true, port: 9333 }));
    const warmer = new JuniorWarmer(db, { ensure, probe: async () => true, sleep: async () => {}, now: () => 0 });

    expect(warmer.request('Z', 'boot')).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(spansOf(db, 'junior_warmup_requested')).toHaveLength(0);
  });
});

describe('Runner boot wiring (demand-gated junior auto-warmup)', () => {
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(() => {
    db.close();
  });

  /** A minimal fake warmer — records requests, never launches. */
  function fakeWarmer() {
    const requests: Array<{ junior: string; reason: string }> = [];
    return {
      requests,
      request(junior: string, reason: 'boot' | 'probe_failed'): boolean {
        requests.push({ junior, reason });
        return true;
      },
      isInFlight: () => false
    };
  }

  async function withStartedRunner(
    db: DbConnection,
    warmer: ReturnType<typeof fakeWarmer>,
    run: () => Promise<void>
  ): Promise<void> {
    const runner = new Runner(db, { BUREAU_POLL_MS: 50 }, undefined, {
      excludeKinds: ['intake.turn'],
      warmer: warmer as unknown as import('../../engine/flow/junior-warmer.ts').JuniorWarmer
    });
    runner.start();
    try {
      await run();
    } finally {
      await runner.stop();
    }
  }

  it('empty queue at boot: NO warm requests (senior Rec3 — the console may open to an empty department)', async () => {
    const warmer = fakeWarmer();
    await withStartedRunner(db, warmer, async () => {
      await pollUntil(() => false, { timeoutMs: 250, label: 'let a few loop ticks pass' }).catch(() => {});
      expect(warmer.requests).toEqual([]);
    });
  });

  it('queued work at boot: boot warm requested for the whole roster (A + B), reasons recorded as boot', async () => {
    insertQueuedTask(db, 'task-bootwarm-1');
    // The task carries a DEAD plan.cycle: it still counts as queued demand for
    // the boot warm, but the reconciler's operator-action skip (C3 senior note
    // #1) prevents the live loop from probing/enqueueing anything — this test
    // must stay hermetic (no real junior ports, no real jobs).
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, created_at)
       VALUES ('plan.cycle:task-bootwarm-1', 'plan.cycle', 'task-bootwarm-1', '{}', 'dead', 1, 1, ?)`,
      new Date().toISOString()
    );
    const warmer = fakeWarmer();
    await withStartedRunner(db, warmer, async () => {
      await pollUntil(() => warmer.requests.length >= 2, { label: 'boot warm fired for the roster' });
      expect(warmer.requests.map(r => r.junior).sort()).toEqual(['A', 'B']);
      expect(warmer.requests.every(r => r.reason === 'boot')).toBe(true);
    });
  });
});
