# Senior verdict — Delivery resume reconciler + delivery-lane isolation (task 923f6006)

**Verdict: APPROVE (round 3)** · round 1 was REVISE (two findings, both fixed).
**Senior:** claude (Claude Code CLI subprocess, headless) · **Model:** claude-opus-4-8
**Kind:** phase4 code-diff review over `git diff main` (engine/runner/test)
**Date:** 2026-09-07

## Round 1 — REVISE (both findings fixed)
1. **[High] The senior-review lock dropped the loser.** `waitMs` was 4 min, but the
   three senior-driving jobs (`plan.cycle`, `work.cycle`, `work.diff-review`) are all
   `maxAttempts: 1`, so a colliding review would time out and die permanently —
   stranding its task (plan/work cycles have no delivery reconciler to re-drive them).
   The docstring falsely claimed the jobs were retryable. **Fixed:**
   `SENIOR_REVIEW_LOCK_DEFAULT_WAIT_MS = 40 min` — longer than any real review, below
   the 45-min review job timeout — so the loser WAITS out the holder and completes;
   only a genuinely wedged senior (>40 min, about to hit its own timeout) makes the
   waiter give up. Docstring corrected. New unit test asserts the loser waits and both
   complete in order (neither dropped).
2. **[Med] Gate-at-tip shadowed the not-mergeable→freshen rule.** A real not-mergeable
   corpse always has an approved phase4 gate at the current tip (pr.merge exists only
   after pr.create, which required the gate; the conflict is with main, so the branch
   tip never moves), so `reconcileDeliveries` re-enqueued the guaranteed-failing
   `gh pr merge` — the #9/#11 thrash — instead of freshen. **Fixed:** the dead-job
   classification (not-mergeable→freshen, transient→retry, hard→park) now runs BEFORE
   the gate-at-tip shortcut. `r-freshen` test updated to include the phase4 gate at tip
   (representative corpse) and asserts freshen, not a re-merge.

## Round 3 — APPROVE
Acceptance table verified against the committed code: never transitions state (parks at
needs-review); correct next-step ordering (classify-dead → gate-at-tip → produce-gate);
idempotent vs live jobs; amend excluded; budget parks; hard-error parks once (no retry);
no nested-lock deadlock (single senior→zcode order, release in finally); claim priority +
concurrency cap correct and tested; bounded thrash on repeated conflict (freshen budget 2,
then reconcile no-ops up to resume budget 3, then parks).

## Minor (fixed post-verdict)
- An unused `DELIVERY_KINDS` const — removed.

## Operator-side verification
tsc `--noEmit` clean; full suite **137 files green**; new tests: tc_reconcile_deliveries
(9 cases), jobs claim-priority, tc_senior_review_lock (serialize + wait-out + release).
