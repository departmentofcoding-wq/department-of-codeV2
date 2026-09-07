# Senior verdict — C3: junior health gate at admission (CDP handshake probe)

**Verdict: APPROVE (round 3)** · round 1/2 were REVISE. **Senior:** claude (Claude Code CLI) ·
**Model:** claude-opus-4-8 · **Date:** 2026-09-07

Admission now gates on junior CDP health: `reconcileQueuedTasks` (async) probes the pinned free
junior with a real `Runtime.evaluate` round-trip before admitting; a wedged junior (port open,
evaluate hangs) → task stays queued, cooldown, fall through to another free+healthy junior.

## Review history
- **Round 1 (REVISE):** senior flagged (F1) unfixed async callers, (F2) probe fails-closed in
  tests, (F3) probe hits the wrong CDP endpoint. **F1/F2 were FALSE** — the full diff (incl.
  `test/`) shows every `reconcileQueuedTasks` caller is `await`ed and the reconcile/flow tests
  inject `{ probe: async () => true }` (verified: 18/18 pass). **F3 was CORRECT.**
- **F3 fixed + validated LIVE (2026-09-07, junior A / Antigravity IDE 1.107):** the probe read
  `webSocketDebuggerUrl` from `/json/version` (the browser target), where `Runtime.evaluate`
  errors `-32601 'wasn't found'`; the PAGE target (`/json/list`) returns `2`. Re-pointed to
  `findMainWindowWs(port)` (the page ws `AntigravitySession` drives); `probeJuniorCdpHealth(A@9333)`
  now returns `true` live. Socket-layer test fakes now serve `/json/list` with a page target.
- **Round 2 (REVISE):** the diff carried stale-base C5-revert baggage (branch cut before C5
  merged). Fixed by merging current main (with C5) into the branch — clean, no conflicts.
- **Round 3 (APPROVE):** F3 fix verified correct, `preferJunior` honored (not a no-op), F1
  retired, roster-exhaustion surfaced loudly + cooldown-throttled.

## Post-APPROVE fix (senior note #1, medium)
The probe ran BEFORE the operator-action/DEAD-cycle skip, so a parked task with a dead
`plan.cycle` was needlessly probed (opening a socket + possibly marking a wedged junior
unhealthy) before being discarded. **Fixed:** the DEAD-cycle skip is hoisted above the probe
loop (original order restored). tsc clean; reconcile/health/queue tests green.

## Non-blocking follow-ups (noted, not fixed)
- Note #2: `isJuniorWedgedWindowError` broadened to `/CDP timeout/i` also gates
  `withJuniorWedgeRecovery`/infra-retry — a transient CDP stall could trigger an IDE restart.
  Defensible for genuine wedges; a conscious call. Candidate to scope to the runner terminal path.
- Note #3: `admission_predicate.ts` is largely decorative in reconcile (its `journalAction`/`reason`
  are unused; reconcile writes its own span). Unit-tested in isolation; fine to keep or inline.

## Operator-side verification
tsc `--noEmit` clean; full suite green bar the known `tc_primary_contamination_guard` N16 /
`t4_crash_resume` parallel-load flakes (green in isolation). F3 fix live-validated against junior A.
