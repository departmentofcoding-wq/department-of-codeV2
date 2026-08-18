# Phase 5 Mutation Evidence Ledger

Every PR in Phase 5 records the guard it broke and the test that caught it, proving real mutation testing was performed on the stream branch before submission for Senior Review.

---

## M-D0-5: Contract Freeze — Bureau Ownership & Watchdog Tables Guard

- **Branch / Milestone**: `wt/junior-a-d0-5` (Milestone D0-5)
- **Guard Broken**: `bureau_ownership` table creation DDL in `engine/db/schema.ts`
- **Mutation Applied**: Commented out `CREATE TABLE IF NOT EXISTS bureau_ownership` in `bootSchema` (`engine/db/schema.ts`).
- **Test Command**: `npx vitest run test/unit/contract_d0_5.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/contract_d0_5.test.ts > Milestone D0-5 — Contract Freeze (Phase 5) > 1. Schema Boot: creates bureau_ownership and bureau_watchdog_findings tables on fresh DB
  AssertionError: expected false to be true // Object.is equality
  - Expected: true
  + Received: false
  expect(tableNames.has('bureau_ownership')).toBe(true);

  FAIL  test/unit/contract_d0_5.test.ts > Milestone D0-5 — Contract Freeze (Phase 5) > 2. Schema Migration: migrates a Phase 4 database by adding recover_attempts and new tables idempotently
  Error: no such table: bureau_ownership
  ```
- **Verification**: Mutation caught by unit test. Restored code passes 3/3 tests cleanly.
