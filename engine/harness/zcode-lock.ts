import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.ts';

/**
 * Cross-process mutex for the ONE ZCode (senior) instance.
 *
 * Scar (2026-08-28 resume): two drivers attaching to the single ZCode instance
 * collide — a second `newConversation()` resets the first driver's in-flight
 * review, orphaning its verdict and killing the job. ZCode is single-instance
 * (a tray process holds the lock), so the department serializes access to it
 * with a lockfile holding `{ pid, acquiredAt }`:
 *
 *   - acquire → exclusive create (`wx`); if held by a LIVE holder younger than
 *     the stale TTL, wait briefly then fail fast with a clear "ZCode busy"
 *     message instead of colliding;
 *   - a stale lock (holder PID gone, or held longer than the TTL) is taken over;
 *   - release → delete the file only if it is still OURS (a taker-over must not
 *     be released by the zombie it displaced). Best-effort, never throws.
 *
 * Unit-tested against temp paths with injected clock/pid probes — no live ZCode.
 */

export interface ZCodeLockInfo {
  pid: number;
  acquiredAt: number;
}

export interface ZCodeLock {
  path: string;
  info: ZCodeLockInfo;
  /** Delete the lockfile iff it still holds OUR acquisition. Never throws. */
  release(): void;
}

export interface ZCodeLockOptions {
  /** Lockfile location. Default: env `ZCODE_LOCK_PATH` or a file in tmpdir. */
  lockPath?: string;
  /** How long to wait for a live holder to release before failing. Default 5s. */
  waitMs?: number;
  /** A lock older than this is takeover-eligible even if its PID looks alive
   *  (crash + PID reuse, or a wedged holder). Default 2h — above any legit
   *  review, which is bounded by the 1h last-resort wait cap. */
  staleTtlMs?: number;
  /** Busy-wait poll interval. Default 250ms. */
  pollMs?: number;
  /** Injectable clock/stubs for unit tests. */
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const ZCODE_LOCK_DEFAULT_WAIT_MS = 5000;
export const ZCODE_LOCK_DEFAULT_STALE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 250;

export function defaultZCodeLockPath(): string {
  return process.env['ZCODE_LOCK_PATH'] || path.join(os.tmpdir(), 'dept-of-code-zcode.lock');
}

/** True when `pid` has a live process (signal 0 probe; EPERM still means alive). */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/** A lock is stale when its holder process is gone OR it outlived the TTL. Pure. */
export function zcodeLockIsStale(
  info: ZCodeLockInfo,
  nowMs: number,
  staleTtlMs: number,
  isPidAlive: (pid: number) => boolean = pidIsAlive
): boolean {
  if (nowMs - info.acquiredAt > staleTtlMs) return true;
  return !isPidAlive(info.pid);
}

function readLockInfo(lockPath: string): ZCodeLockInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return typeof v?.pid === 'number' && typeof v?.acquiredAt === 'number' ? (v as ZCodeLockInfo) : null;
  } catch {
    return null; // missing, unreadable, or corrupt
  }
}

function writeLockExclusively(lockPath: string, info: ZCodeLockInfo): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(info));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

function removeLockIfOurs(lockPath: string, info: ZCodeLockInfo): void {
  try {
    const cur = readLockInfo(lockPath);
    if (cur && cur.pid === info.pid && cur.acquiredAt === info.acquiredAt) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* best-effort: a leftover stale lock is takeover-eligible next acquire */
  }
}

/**
 * Acquire the ZCode single-instance lock. Resolves with the lock (release it in
 * a `finally`), or rejects with a HarnessError when a live holder keeps it past
 * `waitMs` — fail fast with a clear message instead of colliding with the
 * in-flight review.
 */
export async function acquireZCodeLock(opts: ZCodeLockOptions = {}): Promise<ZCodeLock> {
  const lockPath = opts.lockPath ?? defaultZCodeLockPath();
  const waitMs = opts.waitMs ?? ZCODE_LOCK_DEFAULT_WAIT_MS;
  const staleTtlMs = opts.staleTtlMs ?? ZCODE_LOCK_DEFAULT_STALE_TTL_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  const isPidAlive = opts.isPidAlive ?? pidIsAlive;
  const sleep = opts.sleep ?? (async (ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  // One takeover-capable attempt: exclusive-create; if the file exists, it is
  // takeover-eligible when corrupt/unreadable OR stale (dead holder / outlived
  // the TTL) — remove it and retry the create. A concurrent taker that wins
  // the recreate race leaves us 'busy'.
  const attempt = (): { res: 'acquired' | 'busy'; info: ZCodeLockInfo } => {
    const info: ZCodeLockInfo = { pid: process.pid, acquiredAt: now() };
    if (writeLockExclusively(lockPath, info)) return { res: 'acquired', info };
    const held = readLockInfo(lockPath);
    if (!held || zcodeLockIsStale(held, now(), staleTtlMs, isPidAlive)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* raced away — busy */
      }
      const taken: ZCodeLockInfo = { pid: process.pid, acquiredAt: now() };
      if (writeLockExclusively(lockPath, taken)) return { res: 'acquired', info: taken };
    }
    return { res: 'busy', info };
  };

  const deadline = now() + waitMs;
  for (;;) {
    const { res, info } = attempt();
    if (res === 'acquired') {
      return { path: lockPath, info, release: () => removeLockIfOurs(lockPath, info) };
    }
    if (now() >= deadline) {
      const held = readLockInfo(lockPath);
      throw new HarnessError(
        `ZCode is busy: another driver (pid ${held?.pid ?? '?'}, acquired ` +
          `${held ? new Date(held.acquiredAt).toISOString() : '?'}) holds the single-instance lock. ` +
          `Wait for its review to finish, or delete '${lockPath}' if that driver is gone.`
      );
    }
    await sleep(pollMs);
  }
}
