/**
 * Deterministic test synchronization (Milestone B4).
 *
 * Replaces ad-hoc `for (i<40) { sleep(50) }` wall-clock polling with a
 * condition-driven wait: it returns the instant the predicate holds and only
 * fails if a generous deadline elapses. Because it keys off the actual observed
 * state (a DB row, a journal span) rather than a fixed number of sleeps, it is
 * both faster in the common case and robust under load — the property the
 * `fileParallelism: false` band-aid was standing in for.
 */
export async function pollUntil<T>(
  probe: () => T | undefined | null | false,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntil timed out after ${timeoutMs}ms${opts.label ? ` waiting for: ${opts.label}` : ''}`
      );
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}
