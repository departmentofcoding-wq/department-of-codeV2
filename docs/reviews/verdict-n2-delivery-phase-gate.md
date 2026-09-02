# Senior verdict — N2 delivery-gate phase filter (phase4 code-diff review required at the tip)

- **Task:** `714269b8-0b5f-45cb-8cf5-2facb38bf212` ("N2: delivery gate must require a phase4 code-diff senior approval at the tip")
- **Branch:** `wt/n2-delivery-phase-gate` (cut from main `df5e583`)
- **Senior:** zai (ZCode/GLM-5.3), acting senior under operator delegation — the claude
  CLI senior is out of credits. **Disclosure: implementer == reviewer (this session)**
  for this engine-dev fix, forced by the outage; compensated by live mutation
  re-execution, suite ×3, and the fail-closed refusal assertions below.
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-02
- **Verdict:** **APPROVE**

## What was reviewed

The delivery gate (`pr.create`, `pr.merge`) read the LATEST `bureau_work_reviews` row
regardless of phase, so a `walkthrough`-phase approval satisfied delivery and the final
diff was never senior-reviewed before merge (b55e2fda, N1a — "flow-complete, not
diff-verified"). Fix: new `WORK_REVIEW_DIFF_PHASE = 'phase4'` constant
(`engine/contract/constants.ts`) + shared `getDeliveryGatingReview()` helper
(`engine/delivery/diff_review_gate.ts`) selecting the latest APPROVED `phase4` row;
`pr_create.ts` and `pr_merge.ts` now gate on it (existence + `reviewed_commit == tip`,
refusals journaled as guardrail spans, fail-closed `PrRefusalError`/`DeliveryError`
unchanged); the A1 merge-law predicate (`merge_guard.ts`) now blesses out-of-band
commits only with a phase4 approval at that exact commit. The `reviewed_commit == tip`
law is untouched — the phase requirement is strictly additive.

## Independent verification

- **Diff read in full:** 9 changed files + 2 new. The helper is the single query
  shared by both delivery doors (no drift possible); `merge_guard` keeps its own
  predicate (pure, DB-only, hook-safe) tightened identically. Vocabulary confirmed
  against production writers: `phase4` (work_review_job.ts + operator-recorded diff
  reviews — the b55e2fda and N15 precedents) vs `walkthrough` (flow cycle). The
  non-delivery reader (`verify/loop.ts` stale-approval self-heal) deliberately
  unchanged — it is not a delivery decision, and tightening it would change N1(b)
  semantics out of scope.
- **Semantics decision on later rows:** a standing phase4 approval at tip X remains
  valid even if a LATER walkthrough row exists at the same X (same tree — the diff
  review judged exactly those contents); it is invalidated the moment the tip moves
  (stale-refusal test). This matches the task text: "require a phase4 … approval AT
  THE CURRENT TIP, not the latest review of any phase."
- **Suite 694/694 across 125 files, green three consecutive full runs; `tsc --noEmit`
  clean.** New regression file `tc_delivery_phase_gate.test.ts` (8 tests) covers the
  full matrix: walkthrough-at-tip refused (+ journaled guardrail + no PR created),
  plan-phase refused, the exact b55e2fda shape (stale phase4 + walkthrough-at-tip →
  refused), REVISED phase4 refused, phase4-at-tip allowed (both doors), later
  walkthrough row not invalidating, pr.merge mirror.
- **Tests updated, not gamed:** t43/t44 seeds moved to the real `phase4` vocabulary;
  t43's mismatch test asserts the new (clearer) refusal message; t45 now records the
  phase4 diff review at the tip between the human gate and delivery drain — encoding
  the new law in the tail lock; tc_merge_guard gained the walkthrough-only refusal
  case; tc_tail_fixes F3 seed updated.
- **Mutations executed live by this senior:** M-N2a (phase filter removed from the
  gate) → **4 tests failed** including the two incident shapes; M-N2b (merge-guard
  predicate relaxed) → the new merge-law test failed. Both restored → green.
  Recorded in `docs/mutation-evidence-phase8.md`.

## Notes (on the record)

1. A pure-flow task whose only approval is the cycle's walkthrough review will now
   reach `needs-review`, get operator approval, and be REFUSED at pr.create until a
   real phase4 diff review is recorded at the tip (the N15-this-session pattern: the
   acting senior reviews the diff and the row is recorded). That refusal is the
   intended behavior — delivery without diff verification was the incident.
2. The console's display-only latest-review reads (approve.ts audit list) were left
   unchanged (not delivery decisions).
3. Operator follow-up candidates (out of scope, unchanged): a `run_senior`/CLI door to
   record a phase4 review row properly (today it is a scripted insert — this session's
   `deliver_n15`/manual pattern); retroactive phase4 diff review of previously merged
   walkthrough-gated deliveries (N1a was flagged; b55e2fda and N15 now have real
   phase4 rows).

**APPROVE.**
