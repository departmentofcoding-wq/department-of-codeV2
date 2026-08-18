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

---

## M-B1: Milestone B1 — Backup Push Remote Tip Verification Guard (T48)

- **Branch / Milestone**: `wt/junior-b-hardening` (Milestone B1)
- **Guard Broken**: Remote tip mismatch validation in `engine/durability/backup_push.ts`
- **Mutation Applied**: Changed `if (remoteTip !== localTip)` to `if (false && remoteTip !== localTip)` to bypass remote tip verification and force trust of local push.
- **Test Command**: `npx vitest run test/unit/backup_push.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/backup_push.test.ts > T48 — Backup Push Automation & Remote Tip Verification (Milestone B1) > T48: refuses to claim success on a remote-tip mismatch (fails closed with guardrail span)
  AssertionError: promise resolved "undefined" instead of rejecting

  - Expected: 
  Error {
    "message": "rejected promise",
  }

  + Received: 
  undefined

   ❯ test/unit/backup_push.test.ts:97:39
  ```
- **Verification**: Mutation caught by test T48. Restored code passes 2/2 tests cleanly.

---

## M-A1: Milestone A1 — Watchdog Detection Guard (T45)

- **Branch / Milestone**: `wt/junior-a-hardening` (Milestone A1)
- **Guard Broken**: `verifying_no_verify_run` detection query in `engine/watchdog/sweep.ts`
- **Mutation Applied**: Changed `WHERE state = 'verifying'` to `WHERE state = 'MUTATION_BROKEN'` in `detectWatchdogFindings`.
- **Test Command**: `npx vitest run test/unit/t45_watchdog_sweep.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/t45_watchdog_sweep.test.ts > T45 — Watchdog Detection (watchdog.sweep) > 2. Detects verifying_no_verify_run (Class 1)
  AssertionError: expected +0 to be 1 // Object.is equality
  - Expected: 1
  + Received: 0

  FAIL  test/unit/t45_watchdog_sweep.test.ts > T45 — Watchdog Detection (watchdog.sweep) > 6. Idempotency & Unique Index: second sweep on same state produces zero duplicate active findings
  AssertionError: expected +0 to be 1 // Object.is equality
  - Expected: 1
  + Received: 0
  ```
- **Verification**: Mutation caught by T45 test suite. Restored code passes all 7/7 tests cleanly.


