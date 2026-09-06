# Verdict — wire the phase4 code-diff review into the flow (delivery-gate gap)

**Verdict: APPROVE** (acting junior + senior for this fix, at the operator's request, 2026-09-03)
**Delivery:** local `main` only (no GitHub push), per operator direction.

## The bug (root cause of "Approve no longer merges")

N2 (`engine/delivery/diff_review_gate.ts`) made delivery — `pr.create`, `pr.merge`,
and the out-of-band merge guard — key on the latest **approved `phase4` code-diff
review at the branch tip**. But nothing in the automated flow produced that row:

- The harness `work.cycle` records only a `walkthrough` review.
- The only writer of `phase4` rows, the legacy `senior.review-work` job
  (`engine/review/work_review_job.ts`), is registered/handled but **never
  enqueued anywhere**, and is slated for retirement
  (`docs/plan-single-senior-per-task.md` §3).

So every `phase4` row on delivered tasks (`b55e2fda`, `1ac387ee`, `3756ec6e`) was
created **out of band by a peer session** — the exact anti-pattern that plan
forbids. When the operator approved `4d9058fb` and `8b6d7495` (2026-09-02 16:25),
`approveTask` enqueued `pr.create`, which **died** on `"lacks an approved phase4
code-diff review"`. Approve set the columns; delivery hit the gate with no phase4
review present.

## The fix (Option A — harness diff-review)

The task's **same** assigned senior (single-senior-per-task) reviews the real
`git diff base..tip` through the harness and records the `phase4` gate:

- `engine/harness/senior.ts` — `SeniorReviewInput.kind` gains `'diff'` (+ `diff`
  field); `buildReviewPrompt` handles it. Both CLI and CDP drivers build their
  prompt solely via `buildReviewPrompt`, so the new kind flows through.
- `engine/flow/diff_review_cycle.ts` (new) — `runDiffReviewCycle`: reviews at the
  human gate (`needs-review`) only; **dedups** (an approved `phase4` already at the
  tip → skip the senior, chain to delivery); reads the diff over the bureau
  worktree; drives the pinned senior with the stall-retry loop; records the
  `phase4` review at the exact tip; on **APPROVE** chains to `pr.create`
  (idempotent enqueue), on **AMEND** notifies + **holds** in `needs-review`
  (nothing merges), on stall exhaustion holds (the task is already human-approved,
  so it is never demoted).
- `engine/jobs/registry.ts` — registers `work.diff-review` (maxAttempts 1, 45-min
  timeout, like `work.cycle`).
- `engine/state/machine.ts` — `approveTask` enqueues `work.diff-review` instead of
  `pr.create`. Approve → diff-review → (approve) → pr.create → pr.merge. Race-free:
  delivery only fires after the phase4 approve exists.

`pr.create` / `pr.merge` still refuse without an approved `phase4` at the tip —
kept as **defense-in-depth**.

## Why this shape

Only shape consistent with **N2** (the real diff is reviewed), **single-senior-per-task**
(one harness path, no out-of-band reviewer, no legacy `callModel` job), and the
operator's "never bypass the done-gate" rule. Avoids the legacy job's strict
`mutation-evidence-phase4.md` precondition that would reject most real tasks.

## Verification

- New: `test/integration/tc_diff_review_cycle.test.ts` — APPROVE records phase4 at
  tip + chains pr.create; AMEND holds (no pr.create, stays needs-review); DEDUP
  skips the senior; off-gate is skipped.
- Updated: `t42_approval_door`, `state.test`, `tc3_action_api` assert Approve now
  enqueues `work.diff-review`; `t45_delivery_tail` drains
  approve → work.diff-review (dedup) → pr.create → pr.merge → done.
- **Full suite: 739 passed (129 files). `tsc --noEmit` clean.**

## Follow-ups (not in this change)

- AMEND is notify-and-hold; a future revision can loop the fixes back to the junior
  like the walkthrough cycle (bounded by the work-rounds ceiling).
- The two already-approved tasks (`4d9058fb`, `8b6d7495`) were approved before this
  landed; `approveTask` is idempotent, so re-driving them needs a fresh
  `work.diff-review` enqueue (or re-file). N9 still needs its diff rebuilt on
  current main, committed, reviewed, and merged.
- The **runner/console (PID from this session) runs the OLD code** — it must be
  restarted to pick up this fix.
