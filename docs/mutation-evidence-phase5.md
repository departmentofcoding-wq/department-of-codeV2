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

---

## M-A2: Milestone A2 — Watchdog Recovery Budget Ceiling Guard (T46)

- **Branch / Milestone**: `wt/junior-a-hardening` (Milestone A2)
- **Guard Broken**: `recover_attempts` budget ceiling check in `engine/watchdog/recover.ts`
- **Mutation Applied**: Changed `if (finding.recover_attempts >= MAX_RECOVER_ATTEMPTS)` to `if (false && finding.recover_attempts >= MAX_RECOVER_ATTEMPTS)` in `handleWatchdogRecover`.
- **Test Command**: `npx vitest run test/unit/t46_watchdog_recover.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/t46_watchdog_recover.test.ts > T46 — Watchdog Recovery (watchdog.recover) > 4. Budget Ceiling Enforcement: halts runaway recovery loop when recover_attempts >= ceiling
  AssertionError: expected 'recovering' to be 'failed' // Object.is equality
  - Expected: "failed"
  + Received: "recovering"
  ```
- **Verification**: Mutation caught by T46 test suite. Restored code passes all 4/4 tests cleanly.

---

## M-A3: Milestone A3 — Secretary Fail-Closed Double-Claim Refusal Guard (T47)

- **Branch / Milestone**: `wt/junior-a-hardening` (Milestone A3)
- **Guard Broken**: `expires_at > now` active lease refusal check in `engine/secretary/ownership.ts`
- **Mutation Applied**: Changed `if (existing.expires_at > now)` to `if (false && existing.expires_at > now)` in `claimOwnership`.
- **Test Command**: `npx vitest run test/unit/t47_secretary_ownership.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/t47_secretary_ownership.test.ts > T47 — Secretary Authoritative Ownership (secretary.claim / secretary.release) > 2. Double-Claim Refusal (Fail-Closed): second claim on held unexpired key is refused
  AssertionError: expected [Function] to throw an error
  - Expected: null
  + Received: undefined
  ```
- **Verification**: Mutation caught by T47 test suite. Restored code passes all 5/5 tests cleanly.

---

## M-B2: Milestone B2 — Dashboards Read-Only Guard (T49)

- **Branch / Milestone**: `wt/junior-b-hardening-2` (Milestone B2)
- **Guard Broken**: read-only contract of `dashboardSnapshot` in `engine/dashboards/views.ts`
- **Mutation Applied**: Injected an `INSERT INTO bureau_journal` at the top of `dashboardSnapshot`, so a render mutates state.
- **Test Command**: `npx vitest run test/unit/t49_dashboards.test.ts`
- **Result**: `Tests 1 failed | 2 passed (3)` — test 2 ("Read-Only Proof") caught the write (journal snapshot before ≠ after).
- **Verification**: Restored code passes 3/3.

---

## M-B3: Milestone B3 — Red-Team Env-Scrub Guard (T50)

- **Branch / Milestone**: `wt/junior-b-hardening-2` (Milestone B3)
- **Guard Broken**: secret denylist in `scrubEnv` (`engine/contract/tools.ts`)
- **Mutation Applied**: Removed the `!isSecretKey(key)` condition so `scrubEnv` copies every var, secrets included.
- **Test Command**: `npx vitest run test/integration/t50_red_team.test.ts`
- **Result**: `Tests 1 failed | 2 passed (3)` — the exfiltration probe caught the leak (`GOOGLE_API_KEY`/`BUREAU_SECRET` survived into the child env).
- **Verification**: Restored code passes 3/3.

---

## M-B4: Milestone B4 — Deterministic Wait Gate (T4b)

- **Branch / Milestone**: `wt/junior-b-hardening-2` (Milestone B4)
- **Guard Broken**: condition gate in `pollUntil` (`test/helpers/wait.ts`) — proven via T4b's use of it.
- **Mutation Applied**: Changed T4b's reap predicate from `includes('lease-reaped')` to `includes('NEVER-MATCHES')` so the awaited condition never holds.
- **Test Command**: `npx vitest run test/integration/t4_crash_resume.test.ts`
- **Result**: `Tests 3 failed (3)` — `pollUntil` threw `pollUntil timed out after 15000ms waiting for: kill-chain-1 lease-reaped span`, proving the wait gates on the real observed state rather than passing on elapsed sleeps.
- **Note**: B4 is test-infrastructure (a deterministic-sync helper); it has no product-code guard of its own. `fileParallelism: false` is retained in `vitest.config.ts` because the browser-spawning tests (t28/t38) remain the real cross-file contention source; converting those to browser-event waits and flipping parallelism back is deferred, tracked in DEPARTMENT_STATUS.md.
- **Verification**: Restored code passes 3/3.

