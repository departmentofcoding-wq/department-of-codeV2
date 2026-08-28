# Verdict: Department resilience (wt/dept-resilience) — implemented by zai, reviewed by Claude

## VERDICT: APPROVE

zai (ZCode/GLM) implemented the full plan on `wt/dept-resilience` (6 commits atop
main `2d46cc0`). I reviewed the real diffs (not just the walkthrough), ran the
build and suite twice, and checked every acceptance criterion and for fake tests.

## Independently verified
- **Build**: `tsc --noEmit` clean in the worktree.
- **Suite**: **570 passed / 109 files, green twice** (was 522/105 on main → +48 real tests).
- **Main tree untouched** (zai worked only in the nested worktree, as instructed).
- **Tests are real**, not the fake/self-filtering pattern: they inject fakes for
  port-probe/kill/spawn and assert real call-counts and safety properties.

## Per workstream
- **WS1 (senior self-heal)** — `ensureSeniorRunning` (reuse-live / kill-tray-then-
  relaunch-with-debug-flag / poll), `runSeniorWithRecovery` (one mid-death relaunch
  then propagate), `killSeniorProcesses`. **Correctness gate confirmed:**
  `isSeniorConnectionError` returns FALSE for home-screen captures, calibration
  misses, and stalls — so those stay fail-closed and are never retried; a partial
  review is never recorded as a verdict. Tested directly (`tc_senior_resilience`).
- **WS2 (junior wedge recovery)** — `recoverJuniorRunning` (unconditional kill+
  relaunch, correct because a wedged instance has a LIVE port), the exact-message
  classifier `isJuniorWedgedWindowError`, and `runJuniorCommandWithWedgedRecovery`
  wired into `handleJuniorDispatch` (heal + retry once, non-wedged errors
  propagate). Matches the real dead job `8c6f373e`.
- **WS3 (adaptive claude timeout)** — `makeInactivityGuard` (stall resets on each
  stdout/stderr chunk; absolute cap from creation; fires once). Replaces the hard
  20-min kill. New `CLAUDE_SENIOR_STALL_MS` (5m) / `CLAUDE_SENIOR_MAX_MS` (1h);
  legacy `CLAUDE_SENIOR_TIMEOUT_MS` still feeds the cap. Fail-closed preserved
  (stall/cap reject; partial output not resolved). Tested with fake timers.
- **WS4a (markers)** — dropped the persistent-chrome markers (Full access / Add
  context / …) that caused false phantom-verdicts in 3.9.2; retightened to
  empty-screen-only signals (greeting hero, "Select project", "Ask ZCode anything").
- **WS4b (ZCode mutex)** — `zcode-lock.ts`: atomic `wx` lockfile, stale-takeover by
  dead-PID or TTL, `removeLockIfOurs` prevents a displaced zombie from releasing a
  taker's lock; `ZCodeSenior.review` holds it across the whole review + retry.
- **WS4c (docs)** — stale-runner/console-restart note added.

## Minor observations (non-blocking)
1. WS4a keeps a few rotating template-card phrases as markers; harmless because the
   guard needs ≥2 markers AND no VERDICT line, and a real review carries a VERDICT.
2. `removeLockIfOurs` has a tiny read-then-unlink TOCTOU window — best-effort, fine
   for single-machine use.
3. `pkill -f "<exe>"` (non-Windows fallback) could over-match; moot on this Windows
   host (`taskkill /IM`), worth tightening if the dept ever runs on POSIX.

## Recommendation
Mergeable. Merge `--no-ff` to main; then relaunch the runner AND console so the new
self-healing takes effect (console restart mints a new token — operator's call).
