# Walkthrough — Flow-resilience fix pack, Stream 3: recovery doors + cold-start budgets

**Branch:** `wt/junior-a-flow-resilience` · **Tips:** `1283b4d` (hotfixes, verbatim)
+ `f0e88c0` (re-kick door + 90s port wait) · **Base:** `main` = `d334004`
**Plan:** `docs/plan-flow-resilience-fixpack.md` (untracked) · **Status:** NOT
merged — awaiting senior verdict; nothing has touched `main`.

## What this stream delivers

1. **The 2026-08-29 live hotfixes, committed lawfully** (`1283b4d`, verbatim —
   they sat uncommitted in main's tree until now):
   - `MAIN_WINDOW_ATTACH_MS = 60000` — a cold-launched Antigravity workbench
     renders 30–40s after its CDP port answers; the old 20×1s loop misread
     that as a wedge.
   - `recoverJuniorRunning` waits for an attachable MAIN window (injected
     `findMainWindowWs` dep) so the in-flight retry doesn't race the render.
   - Console port reclaim — a fresh launch reclaims its port from a stale
     console process instead of EADDRINUSE-crashing on double-click.
   - Ledger update for 2026-08-28 (was part of the same working-tree set).
2. **`JUNIOR_PORT_WAIT_MS = 90000`** replaces the 30s port-wait default that
   lost the live cold-start race (task `3756ec6e`, journal #866: "no CDP
   endpoint within timeout" at ~33s on a healthy-but-slow launch).
3. **The operator re-kick door** (`f0e88c0`):
   - `engine/flow/rekick.ts` — `rekickTaskFlow`: `queued` task + dead
     `plan.cycle` → the deterministic-id row is RESET (budgets cleared,
     journaled human act; id contract with the filing door/reconciler
     preserved); no row at all → fresh enqueue; `claimed` task + dead
     `junior.dispatch` → identical payload re-enqueued under a new id (the
     2026-08-27 manual runbook, productized). The dead-state guard is two
     layers: a pre-read check AND the `WHERE state='dead'` SQL predicate.
   - `POST /api/tasks/:id/rekick` (ENDPOINTS **33 → 34**, `contract_d0_c`
     updated with the reconciliation note): 200 on revive, 400
     `REKICK_REFUSED` + guardrail span on refusal, token-auth,
     human-operator attribution.

## Claims (re-runnable)

- Suite **603/603 ×2** on this branch (two consecutive full runs green; a
  first run before the final commit had 1 transient failure, test name lost
  to output truncation — the known parallel-load class; the two recorded
  runs after are the evidence).
- `npx tsc --noEmit` clean.
- New tests: `tc_rekick.test.ts` (10), `tc_rekick_api.test.ts` (4), 2
  cold-start budget pins in `tc_junior_resilience.test.ts`; the verbatim
  hotfix tests (3 recovery window-waits) came with `1283b4d`.
- **M-RK1 (real, executed):** stripped BOTH dead-guard layers (`if (false)`
  pre-check + `WHERE id = ?` without the state predicate) →
  `tc_rekick.test.ts` **3 failures** ("REFUSES to touch a live (pending)
  plan.cycle", both idempotence tests). Restored; file re-verified green.

## For the senior to re-run

`npx vitest run test/unit/tc_rekick.test.ts test/unit/tc_rekick_api.test.ts
test/unit/contract_d0_c.test.ts` — then M-RK1 via the recorded edit.

## Honest notes

- The stranded live task `3756ec6e` ("Add a hello marker file", `queued`,
  dead `plan.cycle`) is the live proof case: after this merges and a runner
  relaunches, the operator re-kicks it from the console with junior A up on
  9333. I did not touch the live DB — that act belongs to the operator.
- `JUNIOR_PORT_WAIT_MS` and the attach budget are pinned by tests so the
  values that stranded a real task cannot quietly return; the pin asserts
  the minimum, an operator may still raise them via env/constant.
