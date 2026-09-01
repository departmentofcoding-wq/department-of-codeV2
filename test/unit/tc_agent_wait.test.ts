import { describe, expect, it } from 'vitest';
import { AGENT_PROGRESS_LABEL_RE, ensureCompleted, waitForAgentIdle, type AgentActivity } from '../../engine/harness/agent-wait.ts';

describe('AGENT_PROGRESS_LABEL_RE — only a standalone status label counts as "working"', () => {
  const re = () => new RegExp(AGENT_PROGRESS_LABEL_RE.source, 'i');
  it('matches real progress-indicator labels', () => {
    for (const s of ['Working', 'working', 'Generating', 'Generating…', 'Generating...', 'Thinking', 'Thinking…', 'Running']) {
      expect(re().test(s.trim())).toBe(true);
    }
  });
  it('does NOT match the word inside the agent\'s own reply prose (the real bug)', () => {
    // A GLM review that said "working tree clean" once made the waiter conclude the
    // agent was still generating forever → review ran to the job timeout, no verdict.
    for (const s of [
      'exists on wt/junior-ntfy-notifications, working tree clean apart from the untracked',
      'working tree clean',
      'I am working on it',
      'the network is running slowly',
      'regenerating the plan output',
      'Thinking about edge cases here'
    ]) {
      expect(re().test(s.trim())).toBe(false);
    }
  });
});

// Deterministic tests: scripted activity sequences + instant sleep, so no wall clock.
function scriptedProbe(frames: AgentActivity[]): () => Promise<AgentActivity> {
  let i = 0;
  return async () => frames[Math.min(i++, frames.length - 1)];
}
const noSleep = async () => {};

describe('waitForAgentIdle — adaptive, no hard time cap', () => {
  it('keeps waiting while working, then completes when idle & stable', async () => {
    const frames: AgentActivity[] = [
      { working: true, canSend: false, len: 10 },   // working
      { working: true, canSend: false, len: 25 },   // still working, growing
      { working: false, canSend: false, len: 40 },  // output still streaming (grew)
      { working: false, canSend: true, len: 50 },   // idle, but len changed → not confirmed
      { working: false, canSend: true, len: 50 },   // idle stable 1/2
      { working: false, canSend: true, len: 50 }    // idle stable 2/2 → completed
    ];
    const res = await waitForAgentIdle(scriptedProbe(frames), {
      sleep: noSleep, warmupMs: 0, pollMs: 0, idleConfirmations: 2
    });
    expect(res).toBe('completed');
  });

  it('does NOT complete early while the transcript is still growing', async () => {
    // Idle-looking but still streaming output for a long stretch, then settles.
    const frames: AgentActivity[] = [
      { working: false, canSend: true, len: 10 },
      { working: false, canSend: true, len: 20 },
      { working: false, canSend: true, len: 30 },
      { working: false, canSend: true, len: 30 },
      { working: false, canSend: true, len: 30 }
    ];
    let ticks = 0;
    const res = await waitForAgentIdle(scriptedProbe(frames), {
      sleep: noSleep, warmupMs: 0, pollMs: 0, idleConfirmations: 2,
      onTick: () => ticks++
    });
    expect(res).toBe('completed');
    // It had to see the growth stop before confirming — more than 2 polls.
    expect(ticks).toBeGreaterThan(3);
  });

  it('gives up only on a genuine stall (inactive, cannot send, no progress)', async () => {
    // Stuck: not working, not sendable (e.g. an error/modal), length frozen.
    const frozen: AgentActivity = { working: false, canSend: false, len: 5 };
    // Real timers here so the stall window elapses; keep it tiny.
    const res = await waitForAgentIdle(async () => frozen, {
      warmupMs: 0, pollMs: 5, stallMs: 30
    });
    expect(res).toBe('stalled');
  });

  it('an actively-working agent is never cut off by a stall (indefinite extension)', async () => {
    // Always working: should never stall no matter how long. Cap the test via
    // absoluteMaxMs so it terminates, proving the stall net did NOT fire.
    const busy: AgentActivity = { working: true, canSend: false, len: 1 };
    const res = await waitForAgentIdle(async () => busy, {
      warmupMs: 0, pollMs: 2, stallMs: 20, absoluteMaxMs: 60
    });
    expect(res).toBe('timeout'); // hit the huge safety net, NOT 'stalled'
  });

  it('honors an AbortSignal: a pre-aborted signal returns immediately, mid-wait abort stops the loop', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await waitForAgentIdle(async () => ({ working: true, canSend: false, len: 1 }), {
      sleep: noSleep, warmupMs: 0, signal: ac.signal
    });
    expect(res).toBe('aborted');

    // Mid-wait abort: the agent is mid-generation (would keep extending), but
    // the signal stops the wait on the next poll.
    const ac2 = new AbortController();
    let polls = 0;
    const res2 = await waitForAgentIdle(
      async () => {
        polls++;
        if (polls === 2) ac2.abort();
        return { working: true, canSend: false, len: polls };
      },
      { sleep: noSleep, warmupMs: 0, pollMs: 0, signal: ac2.signal }
    );
    expect(res2).toBe('aborted');
    expect(polls).toBe(2);
  });
});

describe('waitForAgentIdle — requireActivityStart closes the submit→generation gap race', () => {
  // The gap: right after a prompt is submitted the composer looks idle (Send
  // control back, nothing streaming) before the agent shows its Stop/"Thinking"
  // indicator. Without requireActivityStart the waiter counted that gap as an
  // instant completion (~5-9s) and captured app chrome before the reply existed —
  // the ZCode senior "empty home screen" phantom. These lock the fix in.
  const gapThenWorkThenIdle: AgentActivity[] = [
    { working: false, canSend: true, len: 100 },  // baseline seed
    { working: false, canSend: true, len: 100 },  // still in the gap (no start yet)
    { working: false, canSend: true, len: 100 },  // still in the gap
    { working: true, canSend: false, len: 120 },  // generation finally starts
    { working: true, canSend: false, len: 150 },  // streaming
    { working: false, canSend: true, len: 180 },  // grew (still streaming)
    { working: false, canSend: true, len: 180 },  // idle stable 1/2
    { working: false, canSend: true, len: 180 }   // idle stable 2/2 → completed
  ];

  it('does NOT complete during the gap — waits for the agent to actually start', async () => {
    const statuses: string[] = [];
    const res = await waitForAgentIdle(scriptedProbe(gapThenWorkThenIdle), {
      sleep: noSleep, warmupMs: 0, pollMs: 0, idleConfirmations: 2,
      requireActivityStart: true,
      onTick: t => statuses.push(t.status)
    });
    expect(res).toBe('completed');
    // Proof it recognized the pre-generation gap instead of completing in it.
    expect(statuses).toContain('awaiting-start');
    // And that completion came only after activity was observed.
    expect(statuses.indexOf('working')).toBeLessThan(statuses.lastIndexOf('completed'));
  });

  it('WITHOUT the flag, the same idle gap is (wrongly) completed instantly — the bug it fixes', async () => {
    // Same steady idle-looking gap that never generates. Old behavior: instant
    // completion. This is the exact misread that orphaned the GLM verdict.
    const alwaysIdle: AgentActivity = { working: false, canSend: true, len: 5 };
    const buggy = await waitForAgentIdle(async () => alwaysIdle, {
      sleep: noSleep, warmupMs: 0, pollMs: 0, idleConfirmations: 2
    });
    expect(buggy).toBe('completed');
  });

  it('WITH the flag, a prompt that never starts generating stalls loudly (real timers)', async () => {
    const alwaysIdle: AgentActivity = { working: false, canSend: true, len: 5 };
    const fixed = await waitForAgentIdle(async () => alwaysIdle, {
      warmupMs: 0, pollMs: 5, stallMs: 30, requireActivityStart: true
    });
    expect(fixed).toBe('stalled');
  });

  it('a transcript GROWTH spike without any working indicator does NOT satisfy the start gate — stalls, never completes (2026-08-30 incidental-growth capture)', async () => {
    // The measured length jumped once — the echoed prompt finished rendering, or
    // (pre-fix, whole-body length) a session-sidebar clock ticked — but the agent
    // never actually generated: no Stop/"Thinking" indicator ever appeared. Old
    // code let that growth satisfy requireActivityStart and then completed against
    // the app's home-screen chrome (the orphaned-verdict bug). Under the fix, only
    // an explicit `working` observation starts the gate, so this must be read as
    // still-awaiting-start and stall loudly instead of completing.
    const growthSpikeThenIdle: AgentActivity[] = [
      { working: false, canSend: true, len: 100 },  // baseline seed
      { working: false, canSend: true, len: 260 },  // incidental growth spike (NOT generation)
      { working: false, canSend: true, len: 260 },  // idle & stable — the misread window
      { working: false, canSend: true, len: 260 }   // ...stays idle, never generates
    ];
    const res = await waitForAgentIdle(scriptedProbe(growthSpikeThenIdle), {
      warmupMs: 0, pollMs: 5, stallMs: 30, requireActivityStart: true
    });
    expect(res).toBe('stalled');
  });

  it('growth after a real working observation still completes normally (the fix does not over-tighten)', async () => {
    // Once the agent has genuinely started (a working indicator), later streaming
    // growth is trusted as progress as before — the fix only distrusts growth
    // BEFORE the first working observation.
    const workThenGrowThenIdle: AgentActivity[] = [
      { working: false, canSend: true, len: 100 },  // baseline seed
      { working: true, canSend: false, len: 100 },  // genuine start
      { working: false, canSend: true, len: 140 },  // streaming (grew) after start
      { working: false, canSend: true, len: 160 },  // still streaming
      { working: false, canSend: true, len: 160 },  // idle 1/2
      { working: false, canSend: true, len: 160 }   // idle 2/2 → completed
    ];
    const res = await waitForAgentIdle(scriptedProbe(workThenGrowThenIdle), {
      sleep: noSleep, warmupMs: 0, pollMs: 0, idleConfirmations: 2, requireActivityStart: true
    });
    expect(res).toBe('completed');
  });
});

describe('ensureCompleted — a non-completed wait is a hard failure, never a silent verdict', () => {
  it('passes completed through untouched', () => {
    expect(() => ensureCompleted('completed', 'anyone')).not.toThrow();
  });

  it('throws on stalled / timeout / aborted, naming the agent and the reason', () => {
    expect(() => ensureCompleted('stalled', 'ZCode junior')).toThrow(/stalled|stall window/);
    expect(() => ensureCompleted('stalled', 'ZCode junior')).toThrow(/ZCode junior/);
    expect(() => ensureCompleted('timeout', 'senior')).toThrow(/absolute cap/);
    expect(() => ensureCompleted('aborted', 'senior')).toThrow(/aborted/);
    // The contract that matters: partial output must never be recorded as a review.
    expect(() => ensureCompleted('stalled', 'x')).toThrow(/NOT recorded/i);
  });
});

// ---------------------------------------------------------------------------------
// N0 — the completion gate. Live-verified 2026-09-01 (docs/plan-n0-junior-completion.md
// §Step 1 results): an agent that ends its TURN while its own terminal subprocess runs
// renders NO Stop/Cancel/spinner in the DOM — idle+stable alone cannot distinguish
// "waiting on my test run" from "done" (the b55e2fda ~38s false completion). The gate
// holds completion open until the sentinel marker appears (completionEvidence), fails
// LOUD on a markerless state past evidenceTimeoutMs, and re-arms on real activity.
// ---------------------------------------------------------------------------------
describe('waitForAgentIdle — N0 completion gate (sentinel evidence)', () => {
  const gapFrame: AgentActivity = { working: false, canSend: true, len: 30 };

  it('does NOT complete during the subprocess gap; completes only once evidence passes (the b55e2fda shape)', async () => {
    // Turn 1 works → ends its turn with a subprocess running → idle+stable (would
    // COMPLETE pre-fix) ×2 → agent resumes → final reply → evidence true.
    const frames: AgentActivity[] = [
      { working: true, canSend: false, len: 10 },
      { working: true, canSend: false, len: 20 },
      { working: false, canSend: true, len: 30 }, // gap begins
      gapFrame, gapFrame, // idle 2/2 → evidence check #1 → false
      gapFrame, gapFrame, // idle 2/2 again → evidence check #2 → false
      { working: true, canSend: false, len: 40 }, // spontaneous resume
      { working: false, canSend: true, len: 50 }, // final reply lands
      { working: false, canSend: true, len: 50 },
      { working: false, canSend: true, len: 50 } // idle 2/2 → evidence #3 → true
    ];
    let evidenceCalls = 0;
    const res = await waitForAgentIdle(scriptedProbe(frames), {
      sleep: noSleep, warmupMs: 0, pollMs: 0, idleConfirmations: 2,
      completionEvidence: async () => ++evidenceCalls >= 3
    });
    expect(res).toBe('completed');
    // Exactly the three would-complete moments were gated; the first two (inside
    // the gap, ~85s of pending subprocess in the live run) did NOT complete it.
    expect(evidenceCalls).toBe(3);
  });

  it('fails LOUD (stalled via the evidence timeout) when the marker never appears', async () => {
    // Work once, then idle forever with no marker. The regular stall net is held
    // disarmed while evidence is pending, so the dedicated timeout must fire.
    const frames: AgentActivity[] = [
      { working: true, canSend: false, len: 10 },
      { ...gapFrame, len: 30 }
    ];
    const statuses: string[] = [];
    const res = await waitForAgentIdle(scriptedProbe(frames), {
      warmupMs: 0, pollMs: 5, stallMs: 30, idleConfirmations: 2,
      evidenceTimeoutMs: 80,
      completionEvidence: async () => false,
      onTick: i => statuses.push(i.status)
    });
    expect(res).toBe('stalled');
    // It was the EVIDENCE timeout, not the regular stall net, and the waiter said so.
    expect(statuses).toContain('stalled-awaiting-evidence');
    expect(statuses).toContain('awaiting-evidence');
  });

  it('real activity re-arms the evidence clock — two sub-timeout gaps do not add up to a stall', async () => {
    // Gap A (~15 polls) → working burst → gap B (~25 polls) → marker. Each gap is
    // under evidenceTimeoutMs, but their SUM exceeds it: only a per-span clock
    // (reset by the working burst) completes instead of stalling.
    const work: AgentActivity = { working: true, canSend: false, len: 99 };
    const frames: AgentActivity[] = [
      work,
      ...Array(15).fill(gapFrame),
      { working: true, canSend: false, len: 40 },
      ...Array(25).fill({ ...gapFrame, len: 40 })
    ];
    let evidenceCalls = 0;
    const res = await waitForAgentIdle(scriptedProbe(frames), {
      warmupMs: 0, pollMs: 5, stallMs: 10_000, idleConfirmations: 2,
      evidenceTimeoutMs: 200,
      completionEvidence: async () => ++evidenceCalls >= 4
    });
    expect(res).toBe('completed');
    expect(evidenceCalls).toBe(4);
  });
});
