import { HarnessError } from './errors.ts';

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
 * An AbortSignal (job timeout / runner shutdown) is honored every poll: the
 * department's cancellation machinery governs even its longest operations.
 */

/**
 * A live "still generating" status label is a SMALL standalone indicator whose
 * ENTIRE text is a progress word ("Working", "Generating…", "Thinking…",
 * "Running"), optionally with trailing dots/ellipsis. It must NOT match the word
 * embedded in the agent's own reply prose — e.g. a GLM review that says "working
 * tree clean" once made the waiter believe the agent was still generating forever,
 * so the review ran to the job timeout and its verdict was never captured. The
 * harness probes inject this regex and additionally require a childless (leaf)
 * element, so only a real status widget qualifies. Anchored (^…$) on purpose.
 */
export const AGENT_PROGRESS_LABEL_RE = /^(working|generating|thinking|running)(\s*(\.\.\.|…))?$/i;

export interface AgentActivity {
  /** The agent is actively generating (Stop/Cancel visible or a working indicator). */
  working: boolean;
  /** The Send control is available (agent is ready for the next message = idle). */
  canSend: boolean;
  /** Visible transcript length — growth means output is still streaming. */
  len: number;
}

export type WaitResult = 'completed' | 'stalled' | 'timeout' | 'aborted';

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
  /** Require observing the agent actively working (a Stop/Cancel control or a
   * "Working/Thinking/…" indicator, or the transcript growing beyond its initial
   * baseline) at least once before an idle+stable reading may be treated as
   * completion. Closes the race where the brief gap between prompt-submit and
   * generation-start looks idle (Send control back, nothing streaming yet) and is
   * wrongly reported as an instant empty "completion" — which then captures the
   * app chrome instead of the reply. When the agent never starts within the stall
   * window, this yields a loud `stalled` (submit didn't land) instead. Default
   * false, so juniors and existing callers are unaffected. */
  requireActivityStart?: boolean;
  /** N0 completion gate: when idle+stable would be declared "completed", call
   * this and only complete if it returns true. Built for the sentinel marker:
   * an agent that ends its TURN while its own terminal subprocess is still
   * running ("I have launched the test run, I will monitor it") is idle+stable
   * in the chat pane but NOT done — the IDE renders no Stop/Cancel/spinner
   * during that gap (live-verified 2026-09-01, docs/plan-n0-junior-completion.md
   * §Step 1 results), so chat-idleness alone cannot distinguish it. While the
   * gate holds the wait open, the regular stall net stays disarmed (the agent
   * has invisible work in flight); instead a dedicated `evidenceTimeoutMs`
   * bounds the markerless state so a genuinely finished agent that never
   * prints the marker fails LOUD (`stalled`), never silently. */
  completionEvidence?: () => Promise<boolean>;
  /** How long the completion gate may hold the wait open with NO real activity
   * (no working indicator, no transcript growth) before declaring `stalled`.
   * Default 5 minutes — a long test run inside the gap is legitimate; an agent
   * that finished but disobeyed the marker instruction surfaces here. */
  evidenceTimeoutMs?: number;
  /** Cancellation: checked every poll, and before the first. */
  signal?: AbortSignal;
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
  const requireActivityStart = opts.requireActivityStart ?? false;
  const evidenceTimeoutMs = opts.evidenceTimeoutMs ?? 5 * 60 * 1000;
  const sleep = opts.sleep ?? defaultSleep;

  const start = Date.now();
  await sleep(warmupMs);

  let lastLen = -1;
  let firstProbe = true;
  let sawActivity = false;
  let lastActivityAt = Date.now();
  let idleStable = 0;
  // N0: when the completion gate is holding the wait open (idle+stable but the
  // sentinel marker is absent), this is when that markerless state began. Real
  // activity (working/growth) clears it; exceeding evidenceTimeoutMs stalls loud.
  let awaitingEvidenceSince: number | null = null;

  for (;;) {
    if (opts.signal?.aborted) return 'aborted';

    const a = await probe();
    const grew = a.len !== lastLen;
    if (grew) lastLen = a.len;
    // The very first probe merely seeds the length baseline; only a working
    // indicator or growth on a LATER probe proves the agent actually began
    // generating. This is what tells "still spinning up after submit" apart from
    // "genuinely done", so an idle reading in the submit→generation gap is not
    // mistaken for completion.
    const realGrowth = grew && !firstProbe;
    // Under requireActivityStart, ONLY an explicit "working" indicator proves the
    // agent actually began generating — incidental transcript growth (a re-render,
    // the echoed prompt finishing rendering, a status timer tick) must NOT satisfy
    // the start gate. That growth-based satisfaction was exactly how the
    // submit→generation gap got mis-read as an instant empty completion (the
    // 2026-08-30 zai capture). Without the flag, growth stays a valid start signal
    // so juniors and existing callers are unaffected.
    const startedNow = requireActivityStart ? a.working : (a.working || realGrowth);
    if (startedNow) sawActivity = true;
    firstProbe = false;

    let status: string;
    if (a.working || grew) {
      // Actively working or output still streaming — keep waiting, no time cap.
      lastActivityAt = Date.now();
      idleStable = 0;
      awaitingEvidenceSince = null; // real activity re-arms the evidence clock
      status = 'working';
    } else if (a.canSend && (!requireActivityStart || sawActivity)) {
      // Idle and steady — confirm across a couple of polls, then check the N0
      // completion gate before calling it done.
      idleStable++;
      status = `idle(${idleStable}/${idleConfirmations})`;
      if (idleStable >= idleConfirmations) {
        if (opts.completionEvidence) {
          const evidenced = await opts.completionEvidence();
          if (!evidenced) {
            if (awaitingEvidenceSince === null) awaitingEvidenceSince = Date.now();
            if (Date.now() - awaitingEvidenceSince > evidenceTimeoutMs) {
              // The marker never came. Loud stall — a partial transcript must
              // never be recorded as a completed answer.
              opts.onTick?.({
                elapsedMs: Date.now() - start,
                status: 'stalled-awaiting-evidence',
                activity: a
              });
              return 'stalled';
            }
            // The agent has invisible work in flight (its own subprocess): keep
            // waiting, and keep the regular stall net disarmed for now.
            idleStable = 0;
            lastActivityAt = Date.now();
            status = 'awaiting-evidence';
          } else {
            opts.onTick?.({ elapsedMs: Date.now() - start, status: 'completed', activity: a });
            return 'completed';
          }
        } else {
          opts.onTick?.({ elapsedMs: Date.now() - start, status: 'completed', activity: a });
          return 'completed';
        }
      }
    } else {
      // Genuinely inactive (error/modal/login wall) or, when requireActivityStart
      // is set, still in the gap before generation has started. Both are bounded by
      // the stall net below: a prompt that never starts generating stalls loudly
      // instead of being read as an instant empty completion.
      status = requireActivityStart && !sawActivity ? 'awaiting-start' : 'inactive';
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

/**
 * Turn a wait result into a hard failure unless the agent genuinely completed.
 * A stalled or aborted agent produces a PARTIAL transcript; parsing a verdict
 * or plan out of it would record garbage as if it were a real review. Used by
 * every harness call site so no non-completion is silently treated as done.
 */
export function ensureCompleted(result: WaitResult, who: string): void {
  if (result === 'completed') return;
  const reason =
    result === 'stalled'
      ? `no progress for the stall window (error, modal, or login wall?)`
      : result === 'aborted'
        ? 'aborted (job timeout or runner shutdown)'
        : 'hit the last-resort absolute cap';
  throw new HarnessError(`${who} did not complete: ${reason}. Partial output was NOT recorded as a review/plan.`);
}
