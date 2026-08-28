/**
 * Inactivity (stall) guard for streaming subprocesses — the subprocess analogue
 * of agent-wait's adaptive completion policy. A senior CLI that is actively
 * producing output is WORKING, not stuck: the only real bounds are
 *
 *   - **stall** — no output at all for `stallMs` (the process hung, hit a login
 *     wall, or is dead-but-not-closed) → give up; and
 *   - **cap** — `maxMs` elapsed since the guard was created, however busy the
 *     stream, so a pathological output-spewing loop still terminates.
 *
 * Mirrors the GUI agents' waiter (`waitForAgentIdle`): no cap on a genuinely
 * working agent, only a stall window plus a last-resort absolute ceiling.
 * Extracted from `ClaudeCliSenior.spawnClaude` so the timing logic is unit-
 * testable without spawning a real subprocess: call `touch()` on every
 * stdout/stderr `data` event and `done()` when the process closes naturally.
 */

export type GiveUpReason = 'stall' | 'cap';

export interface InactivityGuard {
  /** Register output activity: resets the stall timer. No-op after done/give-up. */
  touch(): void;
  /** The process ended naturally: disarm both timers. Idempotent. */
  done(): void;
}

export interface InactivityGuardOptions {
  /** Quiet for this long (no `touch()`) → onGiveUp('stall'). */
  stallMs: number;
  /** Absolute ceiling measured from guard creation → onGiveUp('cap'). */
  maxMs: number;
  /** Fired at most once, with 'stall' or 'cap'. Kill/reject in here. */
  onGiveUp: (reason: GiveUpReason, info: { silentMs: number; elapsedMs: number }) => void;
}

export function makeInactivityGuard(opts: InactivityGuardOptions): InactivityGuard {
  const startedAt = Date.now();
  const { stallMs, maxMs, onGiveUp } = opts;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTouchAt = startedAt;
  let settled = false; // done() or a give-up has fired; guard is inert afterwards

  const clearTimers = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    if (capTimer !== null) clearTimeout(capTimer);
    stallTimer = null;
    capTimer = null;
  };

  const armStall = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => giveUp('stall'), stallMs);
  };

  const giveUp = (reason: GiveUpReason) => {
    if (settled) return;
    settled = true;
    clearTimers();
    onGiveUp(reason, { silentMs: Date.now() - lastTouchAt, elapsedMs: Date.now() - startedAt });
  };

  capTimer = setTimeout(() => giveUp('cap'), maxMs);
  armStall();

  return {
    touch() {
      if (settled) return;
      lastTouchAt = Date.now();
      armStall();
    },
    done() {
      settled = true;
      clearTimers();
    }
  };
}
