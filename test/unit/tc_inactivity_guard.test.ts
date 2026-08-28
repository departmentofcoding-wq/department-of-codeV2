import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInactivityGuard } from '../../engine/harness/inactivity-guard.ts';

/**
 * WS3 — the claude senior's activity-based give-up, extracted so the timing
 * logic is testable without spawning a real subprocess. The invariant mirrors
 * agent-wait: an actively-streaming process is never cut off; only silence for
 * the stall window, or the absolute cap, gives up — and each fires onGiveUp at
 * most once, never after done().
 */
describe('makeInactivityGuard — activity-based give-up (WS3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('going quiet for stallMs fires onGiveUp("stall") — but not one ms earlier', () => {
    const onGiveUp = vi.fn();
    makeInactivityGuard({ stallMs: 5000, maxMs: 60000, onGiveUp });
    vi.advanceTimersByTime(4999);
    expect(onGiveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]![0]).toBe('stall');
  });

  it('streaming (touch on every data event) keeps it alive far past the stall window', () => {
    const onGiveUp = vi.fn();
    const guard = makeInactivityGuard({ stallMs: 5000, maxMs: 60 * 60 * 1000, onGiveUp });
    // 60s of continuous output at 1 chunk/second — 12x the stall window.
    for (let i = 0; i < 60; i++) {
      guard.touch();
      vi.advanceTimersByTime(1000);
    }
    expect(onGiveUp).not.toHaveBeenCalled();
    // The moment the stream goes silent, the stall window starts counting.
    vi.advanceTimersByTime(5001);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]![0]).toBe('stall');
  });

  it('exceeding maxMs fires onGiveUp("cap") even while streaming', () => {
    const onGiveUp = vi.fn();
    const guard = makeInactivityGuard({ stallMs: 5000, maxMs: 20000, onGiveUp });
    // Constant output: the stall timer never fires, but the cap is absolute.
    for (let i = 0; i < 25; i++) {
      guard.touch();
      vi.advanceTimersByTime(1000);
    }
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]![0]).toBe('cap');
  });

  it('the stall fires before the cap when both windows pass in silence', () => {
    const onGiveUp = vi.fn();
    makeInactivityGuard({ stallMs: 5000, maxMs: 20000, onGiveUp });
    vi.advanceTimersByTime(60000);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]![0]).toBe('stall');
  });

  it('done() (process closed naturally) disarms both timers; late touches are no-ops', () => {
    const onGiveUp = vi.fn();
    const guard = makeInactivityGuard({ stallMs: 5000, maxMs: 10000, onGiveUp });
    guard.touch();
    guard.done();
    guard.done(); // idempotent
    guard.touch(); // a trailing data event after close must not re-arm anything
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('onGiveUp reports the silence and total elapsed at give-up time', () => {
    const onGiveUp = vi.fn();
    const guard = makeInactivityGuard({ stallMs: 5000, maxMs: 60000, onGiveUp });
    vi.advanceTimersByTime(2000);
    guard.touch();
    vi.advanceTimersByTime(5000);
    const info = onGiveUp.mock.calls[0]![1];
    expect(info.silentMs).toBeGreaterThanOrEqual(5000);
    expect(info.elapsedMs).toBeGreaterThanOrEqual(7000);
  });
});
