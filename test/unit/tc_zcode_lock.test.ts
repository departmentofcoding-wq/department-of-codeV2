import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireZCodeLock,
  defaultZCodeLockPath,
  pidIsAlive,
  zcodeLockIsStale,
  ZCODE_LOCK_DEFAULT_STALE_TTL_MS,
  type ZCodeLockInfo
} from '../../engine/harness/zcode-lock.ts';

/**
 * WS4b — the ZCode single-instance mutex. Two drivers attaching to the one
 * ZCode instance collide (a second newConversation() resets the first's
 * in-flight review), so access is serialized by a lockfile. All tests run
 * against temp paths with an injected clock/pid probe — no live ZCode, no
 * waiting on real time.
 */
function tmpLockPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zlock-')), 'zcode.lock');
}

/** Ticking mock clock: every read advances 10ms, so busy-waits terminate fast. */
function tickingClock(start = 1_000_000): { now: () => number } {
  let t = start;
  return { now: () => (t += 10) };
}

function writeLock(pathStr: string, info: ZCodeLockInfo): void {
  fs.writeFileSync(pathStr, JSON.stringify(info));
}

describe('ZCode single-instance lock (WS4b)', () => {
  describe('zcodeLockIsStale (pure)', () => {
    const info: ZCodeLockInfo = { pid: 4242, acquiredAt: 1_000_000 };

    it('a live holder inside the TTL is NOT stale', () => {
      expect(zcodeLockIsStale(info, 1_000_000 + 60_000, 2 * 60 * 60 * 1000, () => true)).toBe(false);
    });

    it('a dead holder PID is stale regardless of age', () => {
      expect(zcodeLockIsStale(info, 1_000_000 + 1_000, ZCODE_LOCK_DEFAULT_STALE_TTL_MS, () => false)).toBe(true);
    });

    it('a live holder that outlived the TTL is stale (crash + PID reuse, or a wedged holder)', () => {
      expect(zcodeLockIsStale(info, 1_000_000 + ZCODE_LOCK_DEFAULT_STALE_TTL_MS + 1, ZCODE_LOCK_DEFAULT_STALE_TTL_MS, () => true)).toBe(true);
    });
  });

  it('pidIsAlive says our own process is alive', () => {
    expect(pidIsAlive(process.pid)).toBe(true);
  });

  it('acquire creates the lockfile (pid + acquiredAt) and release removes it', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    const lock = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => true, sleep: async () => {} });
    try {
      expect(lock.path).toBe(lockPath);
      expect(lock.info.pid).toBe(process.pid);
      expect(typeof lock.info.acquiredAt).toBe('number');
      const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(onDisk).toEqual(lock.info);
    } finally {
      lock.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('a second acquire while a LIVE holder holds the lock fails fast with "ZCode busy"', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    const first = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => true, sleep: async () => {} });
    try {
      // Different pid, alive, fresh → busy; waitMs tiny + ticking clock → fast.
      await expect(
        acquireZCodeLock({ lockPath, waitMs: 100, pollMs: 250, now: clock.now, isPidAlive: () => true, sleep: async () => {} })
      ).rejects.toThrow(/ZCode is busy.*holds the single-instance lock/s);
      // ...and the busy error names the holder so the operator can act.
      await expect(
        acquireZCodeLock({ lockPath, waitMs: 100, now: clock.now, isPidAlive: () => true, sleep: async () => {} })
      ).rejects.toThrow(new RegExp(`pid ${first.info.pid}`));
    } finally {
      first.release();
    }
  });

  it('after release, a second acquire succeeds (no restart needed)', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    const first = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => true, sleep: async () => {} });
    first.release();
    const second = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => true, sleep: async () => {} });
    second.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock whose holder PID is gone (crashed driver)', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    writeLock(lockPath, { pid: 99999, acquiredAt: 1_000_000 });
    const lock = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => false, sleep: async () => {} });
    try {
      expect(lock.info.pid).toBe(process.pid); // OUR takeover, not the corpse's
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(lock.info);
    } finally {
      lock.release();
    }
  });

  it('takes over a lock older than the TTL even though its PID looks alive', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    writeLock(lockPath, { pid: 4242, acquiredAt: 500_000 }); // long before the clock
    const lock = await acquireZCodeLock({
      lockPath,
      staleTtlMs: 60_000,
      now: clock.now,
      isPidAlive: () => true,
      sleep: async () => {}
    });
    try {
      expect(lock.info.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('takes over a corrupt/unreadable lockfile (it could never be released honestly)', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    fs.writeFileSync(lockPath, 'not json at all');
    const lock = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => true, sleep: async () => {} });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release does NOT delete a lock a takeover re-acquired from us', async () => {
    const lockPath = tmpLockPath();
    const clock = tickingClock();
    const ours = await acquireZCodeLock({ lockPath, now: clock.now, isPidAlive: () => true, sleep: async () => {} });
    // While we (nominally) still hold it, a taker with a stale-eligible view
    // replaces the lockfile — e.g. our process was wedged past the TTL.
    const taker: ZCodeLockInfo = { pid: 777, acquiredAt: 5_000_000 };
    writeLock(lockPath, taker);
    ours.release(); // must not remove the taker's lock
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(taker);
    fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
  });

  it('defaultZCodeLockPath honors ZCODE_LOCK_PATH', () => {
    const saved = process.env['ZCODE_LOCK_PATH'];
    process.env['ZCODE_LOCK_PATH'] = path.join('X:', 'custom', 'zcode.lock');
    try {
      expect(defaultZCodeLockPath()).toBe(path.join('X:', 'custom', 'zcode.lock'));
    } finally {
      if (saved === undefined) delete process.env['ZCODE_LOCK_PATH'];
      else process.env['ZCODE_LOCK_PATH'] = saved;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
