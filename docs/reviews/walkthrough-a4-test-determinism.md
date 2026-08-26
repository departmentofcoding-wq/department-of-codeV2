# Walkthrough — A4: retire the test-infrastructure band-aids

**Branch:** `wt/a4-test-determinism` (cut from `main` after A1+A2+A3 merged)
**Stream:** Part A / A4 of `docs/plan-bureau-kernel-roadmap.md`

## What this stream does

Removes the `fileParallelism: false` band-aid in `vitest.config.ts` and makes
its removal safe by converting the wall-clock polling loops in the heavy
integration tests to deterministic condition-waits (`test/helpers/wait.ts`
`pollUntil`).

### Root cause of the old flakes
The band-aid stood in for **timeout-based** flakes, not correctness bugs. The
crash-kill / durability tests waited for a child process to reach a state with a
fixed iteration budget — `for (i < N) { sleep(10) }`. Under concurrent load the
child reached that state *later* than the budget allowed, so a correct run was
scored red. Serializing all files hid this by keeping the machine unloaded.

### The fix
- `vitest.config.ts`: `fileParallelism: true`; `testTimeout`/`hookTimeout` 20s →
  30s (headroom for the genuinely heavy tests); comment rewritten to explain the
  real cause.
- Condition-polling loops → `pollUntil` (returns the instant the state holds,
  fails only after a generous deadline):
  - `t28_crash_safety` — reach `verifying`, resume to `needs-review` (+ per-test
    timeout 40s).
  - `t14_durability` — job claimed (`running`), resumed job `done`.
  - `t4_crash_resume` — parent-chain child `running`, kill-chain child `running`,
    whole chain `allDone`.
  - `t6_dead_letter` — the retry/backoff **sampling** loop kept its per-attempt
    `run_after` observation but now runs to a wall-clock deadline instead of a
    fixed iteration count (so a slow-but-correct dead-letter under load still
    passes).
- Fixed inter-phase sleeps (e.g. the ~1.1s lease-expiry waits) are left as-is —
  they are semantic delays (waiting for a lease TTL to elapse), not flake
  sources.

The real-browser tests and real-subprocess tests are covered by generous
per-test timeouts, not a global serialization: `t30` (15s override), `t38`
(30s exec budget), and — added in this stream after senior review — **`t36`**,
the heaviest real-browser test (more browser round-trips than t30), which
previously had **no** explicit `it()` timeout and silently rode the global
default; it now carries an explicit **45s** budget. All three were included in
the repeated full parallel runs.

## Claims (for independent senior verification)

1. **Parallel and green:** the full suite passes **100 files / 473 tests** with
   `fileParallelism: true`, verified across **repeated** full runs (3× before the
   conversions, 2× after), `npm run build` clean.
2. **Faster:** wall-clock suite time ~102s (serial) → ~42s (parallel), ~2.4×.
3. **Conversions are behavior-preserving:** the four converted files
   (t4/t6/t14/t28) pass in isolation (7 tests) and in the full parallel run; the
   assertions are unchanged — only the *wait* mechanism changed.

## Notes

- **No code-guard mutation for A4** — this is test infrastructure; there is no
  product invariant to mutate. The evidence is the repeated green parallel runs
  and the converted tests passing unchanged. (Honest per the mutation-evidence
  rule: not every stream has a guard to break.)
- `pollUntil` (from the B4 down-payment) is the single deterministic-wait helper;
  this stream finishes the migration the config comment tracked as "remaining
  Phase 5 work".
