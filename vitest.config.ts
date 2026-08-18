import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['engine/**/*.test.ts', 'test/**/*.test.ts'],
    isolate: true,
    // Determinism over speed. Several integration tests spawn real child
    // processes (crash-kill scenarios: t4, t28) and real browsers (t36, t38)
    // and then assert on exactly-once state and timing. When 37+ files run
    // concurrently these contend for CPU and OS process slots, producing
    // load-dependent failures ("expected 1 to be +0", lease-reap timeouts)
    // that pass in isolation. A red suite must never look green and a green
    // suite must never look red, so the heavy tests do not race each other.
    // See docs/DEPARTMENT_STATUS.md "Scars" and phase-5 "Flake hardening".
    // B4 down-payment: the T4b lease-reap poll now uses test/helpers/wait.ts
    // (deterministic condition-wait). The browser-spawning tests (t28/t38)
    // remain the real contention source, so parallelism stays off until they
    // move to browser-event waits too — tracked as remaining Phase 5 work.
    fileParallelism: false,
    // Timing-sensitive integration tests assume an unloaded machine; give
    // them headroom so a slow-but-correct run is not scored as a failure.
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
