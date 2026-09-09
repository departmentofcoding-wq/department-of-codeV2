# Walkthrough — Reliability fix pack R1–R6 (`wt/junior-reliability-fixpack`)

Implementation tip: **`1afe427`** (the branch head; one commit per fix, ordered
R1 → R3 → R2 → R4 → R5 → R6 + regression + evidence). Every claim below was
produced by a real run in this session and can be re-run by the reviewer.
Incident forensics: the 2026-09-08 all-blocked event (three tasks blocked in 51
minutes after a 3-hour cold-junior admission stall); root causes verified
against `db/bureau.db` journal/jobs/dispatches rows and the worktrees on disk.

## What shipped

| Fix | File(s) | Change |
|---|---|---|
| **R1** — salvage must not block a task with a live sibling dispatch | `engine/harness/salvage-detector.ts` | `reconcileDeadDispatchWork` checks for a `running` sibling dispatch before salvaging; journals `dead_dispatch_skipped_live_sibling` and leaves the task `claimed` |
| **R3** — checkpoint failure is loud and never records a false tip | `engine/flow/work_review_cycle.ts` | approve-path checkpoint: one bounded retry, `checkpoint_failed` guardrail span, dirty-tree-after-checkpoint → `blocked` with reason `checkpoint_failed_after_approve` + operator notify; `reviewed_commit` is NEVER recorded while the tree is dirty |
| **R2** — plan-cycle enqueues are idempotent | `engine/flow/plan_review_cycle.ts`, `engine/jobs/ids.ts` | successor rounds enqueue-if-absent with `planCycleRoundJobId(task, round)`; approve AND ceiling dispatch paths share ONE task-keyed dispatch slot (`implementationDispatchJobId`/`RowId`) — a fork cannot mint a second live implementation dispatch |
| **R4** — occupancy sees window leases | `engine/flow/assignment.ts` | `juniorIsOccupied` returns true while an active, non-expired lease exists on the junior's window, regardless of pinned-task states |
| **R5** — dispatch waits/defers instead of fail-fast ×3 | `engine/harness/dispatch-job.ts` | lease acquisition through `waitForWindowLease` (N11 path, `BUREAU_DISPATCH_LEASE_WAIT_MS`, default 120 s); past the budget the dispatch is DEFERRED — row parked `pending`, successor job with `run_after` backoff (15 s × 2ⁿ cap 5 min, ceiling 8), attempts never consumed by contention |
| **R6** — orphaned dispatch rows are reaped | `engine/watchdog/sweep.ts` | `reapOrphanedDispatches` runs every `watchdog.sweep`: `running` dispatches with no live `junior.dispatch` job → finalized `failed` + `dispatch_orphan_reaped` span; idempotent; never touches pending/completed or live-job rows |
| Regression | `test/integration/tc_two_task_concurrency_regression.test.ts` | the incident's broken invariant (N17 one-task-per-junior) through the real admission door: two tasks dispatch on separate juniors, the queued third is refused while leases are held (R4), admitted only after the finished tasks hand off |

New tests: `salvage_detector_r1` (6), `work_review_checkpoint_r3` (6),
`tc_plan_cycle_dedup` (2), `assignment_lease_occupancy_r4` (8),
`tc_dispatch_lease_defer` (3), `watchdog_dispatch_reap_r6` (8),
`tc_two_task_concurrency_regression` (1) — **34 new tests**, every one under both
DB implementations where the fixture idiom applies.
Updated: `tc_dispatch_window_heartbeat` T5 — its same-junior contention
assertions moved from the old fail-fast law to the new wait-and-defer law
(window exclusivity assertions unchanged; that behavior change is the POINT of
R5 and was operator-sanctioned in the fix-pack plan).

Mutations: **M-R1…M-R6** in `docs/mutation-evidence-phase8.md` — each guard
reverted, its test failed exactly as the incident predicted, restored, green.

## How the incident maps to the fixes

1. Cold juniors + pre-warmup runner (03:12–06:21 UTC) — **not addressed here**;
   the junior auto-warmup feature (merged 2026-09-08 morning, `c5ce7c4`) is the
   mitigation and already shipped. This pack is the execution-phase cascade.
2. `41fead04` blocked: junior A's CDP died mid-dispatch ×3 → salvage block was
   CORRECT (real dead dispatch, real work) — R6 now finalizes the phantom
   `running` row it left behind; junior A reliability remains the open
   environment issue.
3. `9cabfabd` falsely blocked at 06:44:41: duplicate dispatch died on window-B
   lease while its sibling ran → **R2** prevents the fork, **R1** prevents the
   false block if a fork slips through, **R5** makes the loser wait/defer
   instead of dying in ~1 s.
4. `fec08495` blocked at 07:06:47: admitted onto junior B freed by the false
   block → **R4** keeps B occupied while any window lease is held.
5. `9cabfabd` re-blocked at 07:12:19 with APPROVED work: silent checkpoint
   failure → false `reviewed_commit` = base → `worktree.prepare` refusal →
   **R3** makes that failure loud, retried, and refuse-to-record.

## Verification (re-runnable)

- `npx tsc --noEmit` — clean on the branch tip (`1afe427`).
- Full suite ×2 on the branch: **938/943** (5 failed) then **940/943** (3
  failed). The suite grew 909 → 943 (34 new tests, all passing in both runs).
  The two failure sets are DISJOINT (run 1: t29_wx_end_to_end, t30_cdp_client,
  t4_crash_resume, tc_dead_dispatch_salvage, tc7_projects_api; run 2:
  t36_end_to_end, tc_journal_completeness, tc_agent_wait) — the documented
  parallel-load flake signature, identical in shape to the pre-change baseline
  (903/909 then 906/909 with different failing sets). **Every failed file was
  re-run and passed in isolation** — including, individually, the two nearest
  this pack (`tc_dead_dispatch_salvage` and `tc_journal_completeness`, 5/5
  together) and `t4_crash_resume` (3/3 alone).
- Each fix's test file green standalone; mutation evidence re-verified after
  the final gate.

## Out of scope (operator recovery, one-time data acts — deliberately not code)

1. `9cabfabd`: commit the staged approved work on `bureau-wt-9cabfabd…`,
   correct the review's `reviewed_commit` to the new tip, re-drive
   `worktree.prepare` → verify → needs-review. After R3 this class self-heals.
2. The three phantom `running` dispatch rows (95fb3a3b / 383b9e39 / a27059f7)
   will be reaped automatically by R6's sweep on the next runner tick after
   deploy.
3. Restart both juniors (A is in cooldown `junior:cooldown:A`), then re-drive
   `fec08495` (nothing lost) and triage `41fead04`'s unstaged worktree diff
   by hand.
