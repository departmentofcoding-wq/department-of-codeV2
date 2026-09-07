# Walkthrough — Delivery resume reconciler + delivery-lane isolation

Fixes two linked defects surfaced 2026-09-06/07 (task `923f6006`, implemented
directly as engine-dev):

1. **Restart never resumes approved-but-undelivered tasks.** The queue manager
   (`reconcileQueuedTasks`) only revives `queued → plan.cycle`; an approved
   needs-review task whose delivery job DIED (dead = terminal) was stuck forever
   (live: `05c6edc0`, `9a5bfa98`, `3756ec6e`).
2. **The delivery/re-review lane could contend with regular task work** — no
   department-wide senior lock (only zai), unbounded runner concurrency.

## Part A — `reconcileDeliveries` (engine/flow/reconcile_deliveries.ts)
A new bounded, idempotent, **classified** pass, run every runner tick + boot
(wired in `runner/main.ts` loop + `reconcileDeliveries()` method):

- **Candidate:** `needs-review`, unarchived, not merged, approved
  (`approved_at`+`approved_by`), `verifier_exit_code=0`, with NO live
  (pending/running) delivery job.
- **Next step, from state:** approved phase4 at the current tip → `pr.merge`
  (PR exists) / `pr.create` (no PR); no gate + `pr.merge` dead "not mergeable" →
  `delivery.freshen`; dead + transient error → retry the same kind; dead + hard
  (non-transient) error → **park once** (journal + notify, no retry); otherwise →
  `work.diff-review` to (re)produce the gate at the tip.
- **Excluded:** a latest phase4 verdict of `amend` (owes a junior fix, not
  delivery). A worktree/branch gone (e.g. `3756ec6e`) parks once as
  `delivery_resume_no_worktree`.
- **Bounded:** a `DELIVERY_RESUME_BUDGET` (3) counted from `delivery_resume`
  journal spans → parks `delivery_resume_exhausted`.
- **Never transitions state.** `needs-review → blocked` is illegal; the pass
  PARKS at needs-review with a one-time loud signal (mirrors the freshen
  precedent and the N15 manual repair).

## Part B — lane isolation
- **Senior-review mutex** (engine/harness/senior-review-lock.ts): a
  department-wide `withSeniorReviewLock` wrapping BOTH `ClaudeCliSenior.review`
  and `ZCodeSenior.review`, so at most one senior review runs at a time (delivery
  re-review vs regular review — the N15/N10 contention scar; also serializes an
  operator's manual drive against a runner review). Reuses the proven zcode-lock
  file primitive at a distinct path; for zai the order is senior-review (outer) →
  zcode instance (inner), one consistent order, no deadlock. A busy holder past
  the wait fails fast; the delivery review job is retryable.
- **Runner concurrency cap** (`BUREAU_MAX_CONCURRENT_JOBS`, default 2): the loop
  stops claiming past the cap so a burst of heavy delivery/freshen reverifies
  can't starve regular work.
- **Claim priority** (`claimJob` ORDER BY): regular-flow kinds
  (plan.cycle/junior.dispatch/work.cycle) are claimed before delivery kinds
  (pr.create/pr.merge/delivery.freshen/work.diff-review); FIFO within each lane.

Junior capacity is unchanged (needs-review already frees the junior under N17).

## Tests
- `tc_reconcile_deliveries.test.ts` — 8 cases: no-gate→diff-review, gate→merge,
  gate→create, conflict→freshen, amend-excluded, hard-error→park-once,
  not-approved/live-job excluded, budget→park.
- `jobs.test.ts` — claim prefers regular over delivery, FIFO within a lane.
- `tc_senior_review_lock.test.ts` — serializes, releases (incl. on throw).

Suite green; tsc clean.
