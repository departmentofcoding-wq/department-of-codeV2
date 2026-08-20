import { describe, expect, it } from 'vitest';
import { waitForAgentIdle, type AgentActivity } from '../../engine/harness/agent-wait.ts';

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
});
