# Senior verdict — N11 plan-authoring window-lease serialization

- **Task:** `0e921cfa` ("N11: serialize same-junior plan authoring on the per-junior window lease")
- **Branch:** `wt/n11-authoring-window-lease` (cut from main after `f2c60dc`)
- **Senior:** zai (ZCode/GLM-5.3), acting senior under operator delegation (claude
  senior out of credits). **Disclosure: implementer == reviewer (this session)**,
  compensated by live mutation execution, suite ×3, and concurrency-proof tests.
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-02
- **Verdict:** **APPROVE**

## What was reviewed

`junior.dispatch` acquires the `window-${junior}` lease, but plan AUTHORING called
the Antigravity driver directly with NO lease — two same-junior cycles each
cold-launched the IDE (two windows for one junior — the operator-observed RAM waste)
and collided on cold-start attach, killing cycles (the N10/N9 authoring deaths).

Fix: authoring acquires the SAME lease target a dispatch uses, through a new bounded
`waitForWindowLease` (`engine/harness/lease-manager.ts`) — it polls `acquireLease`
(2s default poll; 250ms from the authoring call site) until the window frees, because
a same-junior cycle must WAIT, not die: the holder heartbeats (b55e2fda mechanism,
now started around authoring too), so a live authoring keeps its window and a dead
holder's lease expires and becomes acquirable. Budget default
`DEFAULT_AUTHORING_LEASE_WAIT_MS` = 10 min (`juniorLeaseWaitMs` opt / carried across
rounds); on timeout the cycle throws a LeaseError naming the contention — loud,
operator-re-armable, exactly as before. Acquisition is journaled
(`plan_authoring_window_lease_acquired`, with `waited: true/false`); release runs in
`finally` (failure path included).

Enabling change: `bureau_window_leases.dispatch_id` dropped its FK to
`bureau_dispatches` — a window holder is legitimately not always a dispatch
(`plan.cycle:<taskId>`). Fresh schema updated; existing DBs rebuilt by a guarded,
idempotent boot migration (fires only when the live DDL still carries the FK; rows
preserved; `foreign_key_check` run inside the rebuild, mirroring the bureau_tasks
rebuild precedent).

## Independent verification

- **Diff read in full.** Placement checked: the lease wraps ONLY the authoring
  `runCommand`; rubric/senior-review/dispatch run OUTSIDE the hold (a junior's window
  must not stay pinned while a slow senior reviews — that would serialize the two
  juniors' REVIEW phase behind window leases it doesn't need).
- **Concurrency semantics hand-traced:** `Promise.all` of two same-junior cycles —
  first acquires immediately, second's first `acquireLease` throws LeaseError →
  waits (250ms polls) → acquires after the first's `finally` release. Never two
  authors in one window; both complete.
- **Suite 703/703 across 127 files, three green full runs; `tsc --noEmit` clean.**
  New `tc_plan_authoring_lease.test.ts` (4 tests): the serialization proof
  (`maxInFlight === 1`, both cycles approved, both leases released, one
  `waited:false` + one `waited:true` acquisition span); failure-path release (next
  same-junior cycle acquires immediately, completes, no active lease left);
  wait-timeout loud failure (external holder untouched, no authoring span);
  the boot migration (a raw pre-N11 DB with the FK + rows → rebuilt without the FK,
  rows preserved, non-dispatch holder accepted, reopen idempotent).
- **Mutation M-N11 executed live:** lease released immediately (serialization
  bypassed) → the concurrency test FAILED with `maxInFlight` 2 — the exact scar;
  restored → green. Recorded in `docs/mutation-evidence-phase8.md`.

## Notes (on the record)

1. Dispatch-vs-authoring contention on the same window still fails FAST on the
   dispatch side (its `acquireLease` is unchanged fail-fast with job retries) —
   authoring is the long, colliding path this fix targets; dispatch lease-conflict
   retry semantics are N12 territory.
2. The resident console/runner currently running holds the OLD schema in memory; the
   migration runs at its next DB open. Any process restart picks it up; the rebuild
   is guarded + idempotent (proven by test).
3. Stuck task `0e921cfa` itself: its junior's uncommitted worktree work (the ~349-line
   N11 attempt) stays in its worktree for operator inspection; this implementation is
   independent and the task row is closed with the Completed tag citing this merge.

**APPROVE.**
