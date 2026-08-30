import { describe, expect, it, vi } from 'vitest';
import { pruneWithRetry } from '../../engine/worktrees/prune.ts';

/**
 * Bounded post-merge prune retry (the 2026-08-28 EPERM scar: the junior IDE
 * held the worktree dir at merge time, one prune try abandoned it, and stale
 * directories would accumulate at exactly the rate Phase 8 multiplies tasks).
 * The policy is pure and injected — no wall clocks, no real fs.
 */

const noSleep = async (_ms: number) => {};

describe('pruneWithRetry', () => {
  it('succeeds on the first attempt with no sleeps', async () => {
    const prune = vi.fn(async () => {});
    const sleep = vi.fn(noSleep);
    const res = await pruneWithRetry(prune, [2000, 10000], sleep);
    expect(res).toEqual({ ok: true, attempts: 1 });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries through transient failures (EPERM clears once the IDE releases the dir)', async () => {
    let calls = 0;
    const prune = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('EPERM, Permission denied');
    });
    const sleep = vi.fn(noSleep);
    const res = await pruneWithRetry(prune, [2000, 10000], sleep);
    expect(res).toEqual({ ok: true, attempts: 3 });
    expect(prune).toHaveBeenCalledTimes(3);
    // One sleep per retry: after attempt 1 and after attempt 2.
    expect(sleep.mock.calls.map(c => c[0])).toEqual([2000, 10000]);
  });

  it('gives up after the bounded attempts and reports the last error for the deferral span', async () => {
    const prune = vi.fn(async () => {
      throw new Error('EPERM, Permission denied');
    });
    const res = await pruneWithRetry(prune, [2000, 10000], noSleep);
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3); // 1 immediate + 2 delayed — BOUNDED
    expect(res.lastError).toContain('EPERM');
  });

  it('bounds to exactly one attempt when no delays are given', async () => {
    const prune = vi.fn(async () => {
      throw new Error('EPERM');
    });
    const res = await pruneWithRetry(prune, [], noSleep);
    expect(res.attempts).toBe(1);
  });
});
