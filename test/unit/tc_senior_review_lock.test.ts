import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSeniorReviewLock } from '../../engine/harness/senior-review-lock.ts';

/**
 * The department-wide senior-review mutex: at most one senior review at a time
 * (delivery re-review vs regular review — the N15 contention scar). Reuses the
 * zcode-lock file primitive at a distinct path.
 */
describe('withSeniorReviewLock', () => {
  const locks: string[] = [];
  function tmpLock(): string {
    const p = path.join(os.tmpdir(), `dept-senior-review-test-${Math.random().toString(36).slice(2)}.lock`);
    locks.push(p);
    return p;
  }
  afterEach(() => {
    for (const p of locks) try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  });

  it('runs the body and releases the lock (sequential acquires both succeed)', async () => {
    const lockPath = tmpLock();
    expect(await withSeniorReviewLock(async () => 'a', { lockPath })).toBe('a');
    expect(fs.existsSync(lockPath)).toBe(false); // released
    expect(await withSeniorReviewLock(async () => 'b', { lockPath })).toBe('b');
  });

  it('serializes: a second acquire fails fast while the first holds it', async () => {
    const lockPath = tmpLock();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withSeniorReviewLock(() => held, { lockPath, waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 30)); // let `first` acquire

    await expect(withSeniorReviewLock(async () => 'second', { lockPath, waitMs: 50 })).rejects.toThrow(/busy/i);

    release();
    await first;
    // Freed now — a fresh acquire succeeds.
    expect(await withSeniorReviewLock(async () => 'ok', { lockPath, waitMs: 200 })).toBe('ok');
  });

  it('releases the lock even when the body throws', async () => {
    const lockPath = tmpLock();
    await expect(withSeniorReviewLock(async () => { throw new Error('boom'); }, { lockPath })).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(await withSeniorReviewLock(async () => 'recovered', { lockPath })).toBe('recovered');
  });
});
