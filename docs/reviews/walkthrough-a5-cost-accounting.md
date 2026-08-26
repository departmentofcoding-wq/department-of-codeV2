# Walkthrough — A5: cost accounting meets reality

**Branch:** `wt/a5-cost-accounting` (cut from `main` after A1–A4 merged)
**Stream:** Part A / A5 of `docs/plan-bureau-kernel-roadmap.md`

## What this stream does

Makes cost real: per-model pricing (updatable), a rollup that computes dollars
from tokens × price where spans carried none, and one monthly-style rollup over
the live journal — all while keeping the honesty rule that **unpriced spend is
not $0**. This is also the proving ground for the kernel's generic spend-guard
before any capital-at-risk department.

### Pricing (`engine/ledger/pricing.ts`)
`getModelPrice(db, model)` resolves a price from `bureau_meta`
(`price:<model>:in_usd_per_mtok` / `:out_usd_per_mtok`, operator-updatable at
runtime) first, then the `bureau_models` price columns, else **null = unpriced**.
`setModelPrice` writes the meta keys; `costOf` computes tokens × price.

### Rollup (`engine/ledger/rollups.ts`, additive)
`ModelAttributionRollup` gains `computed_cost_usd`, `total_cost_usd`,
`cost_basis` (`recorded|computed|mixed|unpriced|none`), and `unpriced_acts`. The
existing `cost_usd` / `cost_recorded` fields are **unchanged** (back-compat —
`ledger.test.ts` passes untouched). For spans that carried no recorded cost, the
rollup values the tokens IF the model is priced (computed); if not, those acts
are counted as `unpriced_acts` and never folded into the dollar figure as $0.
`getPeriodCostRollup(db, {sinceIso?, untilIso?})` sums recorded + computed and
sets `has_unpriced_spend` — so the total is explicitly a **floor** whenever real
spend is unpriced.

### The real rollup (`scripts/cost_report.ts`, `npm run cost:report`)
Prints the period rollup from the live DB. Actual output on `db/bureau.db`:
the Google officer model shows **23,445 in / 3,517 out tokens across 22 acts but
`basis=unpriced` (21 unpriced acts)** — real spend the ledger flags as a floor,
never silently $0. Grouping is clean (A2's attribution fix in effect).

## Claims (for independent senior verification)

1. **Suite green:** `479 / 101` (was 473/100 → +6, the cost test file);
   `npm run build` clean. `ledger.test.ts` unchanged and passing (back-compat).
2. **Honesty preserved:** an unpriced model with real token spend rolls up to
   `total_cost_usd = 0`, `cost_basis = 'unpriced'`, `unpriced_acts > 0` — the
   tokens are recorded, the dollars are declared unknown, not zero.
3. **Computed cost is real:** a priced model with tokens but no recorded cost
   yields `computed_cost_usd = tokens × price`, `cost_basis = 'computed'`.
4. **Updatable pricing:** meta price overrides the model-column price and is
   picked up on the next rollup (no restart).
5. **Mutation M-COST-1:** defaulting an unpriced model to a $0 price
   (`getModelPrice(...) ?? {0,0}`) makes the honesty and period-floor tests fail
   (2/6); restored → 6/6.

## Notes
- `getModelAttributionRollups(db)` is now a thin wrapper over the windowed form
  (no duplication).
- No prices are auto-seeded — the operator sets them via `setModelPrice`/meta.
  Until then the ledger honestly reports real token spend as unpriced (a floor),
  which is the correct default given the current free-tier / GUI-agent roster.
