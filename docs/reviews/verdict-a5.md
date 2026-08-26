# Senior verdict — A5 (real per-model cost accounting) + Phase 8/9/10 plans + ledger

**Senior:** claude (Claude CLI, headless) · **Branch:** wt/a5-cost-accounting · **Verdict:** APPROVE

zai (ZCode/GLM) was requested but its CDP endpoint (:9335) was not exposed this
session (ZCode running without --remote-debugging-port=9335; the harness refuses
to relaunch the operator's editor), so the claude senior reviewed instead — the
same senior that reviewed A1–A4.

Verified by static review: schema already has bureau_models price columns +
bureau_meta (no migration); DbConnection/Statement signatures match the
parameterized queries + upsert; windowed journal query supported; back-compat
holds (ledger.test.ts uses field-by-field assertions, not deep-equal, so the
additive ModelAttributionRollup fields don't break it); the honesty invariant
(unpriced ≠ $0) is real; M-COST-1 traces correctly through cost_basis/unpriced_acts.

**Non-blocking follow-ups (approved to merge; edge cases outside the primary API):**
1. An explicitly $0-priced model with token spend but no recorded cost is labeled
   `cost_basis: 'mixed'` instead of `'computed'` (computed is $0, so it misses the
   `computed > 0` branch). Cosmetic; total_cost_usd and has_unpriced_spend stay correct.
2. A half-set price (only in OR only out set via raw meta, bypassing setModelPrice
   which always sets both) reads the unset direction as $0 rather than unpriced.
Both require unusual data states; neither breaks the dollar totals or the floor flag.
