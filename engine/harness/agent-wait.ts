/**
 * Adaptive completion wait for autonomous agents (juniors and seniors).
 *
 * We do NOT cap how long an agent may take to think/plan/review — a senior that
 * re-runs the whole suite and browses the app is doing its job, and cutting it
 * off at a fixed clock produces false "still working" captures. Instead we watch
 * whether it is *making progress* and only stop when it is genuinely done or
 * genuinely stuck:
 *
 *   - **still working** (a Stop/Cancel control is present, or a "Working/Generating/
 *     Thinking" indicator, or the transcript is still growing) → keep waiting,
 *     indefinitely, resetting the stall timer.
 *   - **idle & stable** (the Send control is back and the text held steady across a
 *     couple of polls) → completed.
 *   - **inactive but not completing** for `stallMs` (no progress, can't send —
 *     e.g. an error, a login wall, a modal) → stalled; give up.
 *
 * So the only real bound is the *inactivity* window, not total elapsed time.
 */

export interface AgentActivity {
  /** The agent is actively generating (Stop/Cancel visible or a working indicator). */
  working: boolean;
  /** The Send control is available (agent is ready for the next message = idle). */
  canSend: boolean;
  /** Visible transcript length — growth means output is still streaming. */
  len: number;
}

export type WaitResult = 'completed' | 'stalled' | 'timeout';

export interface WaitOptions {
  /** How often to poll. Default 2000ms. */
  pollMs?: number;
  /** How long to tolerate NO progress (not working, not growing, not sendable)
   *  before declaring a stall. This is the only practical bound. Default 120000ms. */
  stallMs?: number;
  /** Consecutive idle+stable polls required to call it completed. Default 2. */
  idleConfirmations?: number;
  /** Last-resort absolute safety net so a pathological loop can't run forever.
   *  Deliberately huge — legitimate long reviews finish well inside it. Default 1h. */
  absoluteMaxMs?: number;
  /** Small initial delay so the working indicator can appear. Default 1200ms. */
  warmupMs?: number;
  /** Progress callback (elapsed, current status, activity) for logging. */
  onTick?: (info: { elapsedMs: number; status: string; activity: AgentActivity }) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Wait until an agent is done, extending as long as it keeps working. `probe`
 * returns the current activity; it is called every `pollMs`.
 */
export async function waitForAgentIdle(
  probe: () => Promise<AgentActivity>,
  opts: WaitOptions = {}
): Promise<WaitResult> {
  const pollMs = opts.pollMs ?? 2000;
  const stallMs = opts.stallMs ?? 120000;
  const idleConfirmations = opts.idleConfirmations ?? 2;
  const absoluteMaxMs = opts.absoluteMaxMs ?? 60 * 60 * 1000;
  const warmupMs = opts.warmupMs ?? 1200;
  const sleep = opts.sleep ?? defaultSleep;

  const start = Date.now();
  await sleep(warmupMs);

  let lastLen = -1;
  let lastActivityAt = Date.now();
  let idleStable = 0;

  for (;;) {
    const a = await probe();
    const grew = a.len !== lastLen;
    if (grew) lastLen = a.len;

    let status: string;
    if (a.working || grew) {
      // Actively working or output still streaming — keep waiting, no time cap.
      lastActivityAt = Date.now();
      idleStable = 0;
      status = 'working';
    } else if (a.canSend) {
      // Idle and steady — confirm across a couple of polls, then it's done.
      idleStable++;
      status = `idle(${idleStable}/${idleConfirmations})`;
      if (idleStable >= idleConfirmations) {
        opts.onTick?.({ elapsedMs: Date.now() - start, status: 'completed', activity: a });
        return 'completed';
      }
    } else {
      status = 'inactive';
    }

    opts.onTick?.({ elapsedMs: Date.now() - start, status, activity: a });

    // Stall net: inactive with no progress for stallMs → give up (not a legit long run).
    if (!a.working && !grew && Date.now() - lastActivityAt > stallMs) {
      return 'stalled';
    }
    // Last-resort absolute cap (should never bite a legitimate review).
    if (Date.now() - start > absoluteMaxMs) {
      return 'timeout';
    }

    await sleep(pollMs);
  }
}
