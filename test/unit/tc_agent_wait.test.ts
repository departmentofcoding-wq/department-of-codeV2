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
