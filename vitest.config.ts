import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['engine/**/*.test.ts', 'test/**/*.test.ts'],
    isolate: true,
    // File parallelism is ON (A4). The load-dependent flakes the old
    // `fileParallelism: false` band-aid stood in for came from wall-clock
    // polling loops (`for (i<N) { sleep(10) }`) in the crash-kill / durability
    // integration tests (t4, t6, t14, t28): under concurrent load the child
    // process reached the awaited state later than a fixed iteration budget
    // allowed, so a correct run was scored red. Those waits are now
    // condition-driven via `test/helpers/wait.ts` (`pollUntil`) with generous
    // deadlines — they return the instant the state holds and only fail after a
    // real timeout, so a slow-but-correct run under load is never a false
    // failure. The generous per-test `testTimeout` remains the safety net for
    // the genuinely heavy tests (real browsers: t30/t38; real subprocesses:
    // t4/t14/t28). Verified green across repeated full parallel runs.
    fileParallelism: true,
    // Timing-sensitive integration tests assume an unloaded machine; give
    // them headroom so a slow-but-correct run is not scored as a failure.
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
