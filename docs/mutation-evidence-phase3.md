# Phase 3 Mutation Evidence

This document records mutation testing evidence for Phase 3 milestones per standing law (AGENTS.md). Each entry names the guard broken, the exact file modified, and the test failure output captured when the guard was removed.

---

## Milestone C0 — Contract Freeze

### Mutation 1: Remove Partial UNIQUE Index `idx_window_leases_active`
- **Guard Modified:** Removed `idx_window_leases_active` partial UNIQUE index on `bureau_window_leases (window_target) WHERE status = 'active'` in [`engine/db/schema.ts`](file:///d:/Dept%20of%20code%20v2/engine/db/schema.ts).
- **Test Caught:** [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts) > `enforces window lease partial UNIQUE index exclusivity (C0-A3)`
- **Failure Output:**
  ```text
  FAIL  test/unit/contract_c0.test.ts > Milestone C0 Contract & Schema Freeze > Database Schema & Boot Migrations (C0-A3) > enforces window lease partial UNIQUE index exclusivity (C0-A3)
  AssertionError: expected [Function] to throw an error
   ❯ test/unit/contract_c0.test.ts:242:10
      240|           VALUES ('lease-2', 'window-1', 'disp-2', 'active', '${now}', '${expires}', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
      241|         `);
      242|       }).toThrow();
  ```

---

### Mutation 2: Remove `bureau_observations.nonce UNIQUE` Constraint
- **Guard Modified:** Removed `UNIQUE` keyword from `nonce TEXT UNIQUE NOT NULL` on `bureau_observations` in [`engine/db/schema.ts`](file:///d:/Dept%20of%20code%20v2/engine/db/schema.ts).
- **Test Caught:** [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts) > `enforces bureau_observations.nonce UNIQUE constraint (C0-A1)`
- **Failure Output:**
  ```text
  FAIL  test/unit/contract_c0.test.ts > Milestone C0 Contract & Schema Freeze > Database Schema & Boot Migrations (C0-A3) > enforces bureau_observations.nonce UNIQUE constraint (C0-A1)
  AssertionError: expected [Function] to throw an error
   ❯ test/unit/contract_c0.test.ts:284:10
      282|           VALUES ('obs-2', 'disp-obs', '${testNonce}', 'sel.btn', '{}', 'junior-engineer', 'ollama', 'qwen', '${now}');
      283|         `);
      284|       }).toThrow();
  ```

---

### Mutation 3: Remove `bureau_dispatches.attempts` Entry from `ADDED_COLUMNS`
- **Guard Modified:** Removed `{ table: 'bureau_dispatches', name: 'attempts', definition: 'INTEGER NOT NULL DEFAULT 0' }` from `ADDED_COLUMNS` in [`engine/db/schema.ts`](file:///d:/Dept%20of%20code%20v2/engine/db/schema.ts).
- **Test Caught:** [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts) > `migrates a Phase 2 database by adding dispatches.attempts, new tables, and partial index`
- **Failure Output:**
  ```text
  FAIL  test/unit/contract_c0.test.ts > Milestone C0 Contract & Schema Freeze > Database Schema & Boot Migrations (C0-A3) > migrates a Phase 2 database by adding dispatches.attempts, new tables, and partial index
  AssertionError: expected false to be true // Object.is equality
   ❯ test/unit/contract_c0.test.ts:201:57
      199|       // Assert attempts column exists and preserved pre-existing row
      200|       const postCols = db.prepare('PRAGMA table_info(bureau_dispatches)').all() as Array<{ name: string }>;
      201|       expect(postCols.some(c => c.name === 'attempts')).toBe(true);
  ```

---

### Mutation 4: Remove Status CHECK Constraint on `bureau_selectors`
- **Guard Modified:** Removed `CHECK (status IN ('draft','calibrating','calibrated','failed'))` from `bureau_selectors.status` in [`engine/db/schema.ts`](file:///d:/Dept%20of%20code%20v2/engine/db/schema.ts).
- **Test Caught:** [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts) > `enforces status CHECK constraints on selectors and window leases (C0-A3)`
- **Failure Output:**
  ```text
  FAIL  test/unit/contract_c0.test.ts > Milestone C0 Contract & Schema Freeze > Database Schema & Boot Migrations (C0-A3) > enforces status CHECK constraints on selectors and window leases (C0-A3)
  AssertionError: expected [Function] to throw an error
   ❯ test/unit/contract_c0.test.ts:308:10
      306|           VALUES ('sel-invalid', 'btn.submit', '.submit', 'invalid_status', 'junior-engineer', 'ollama', 'qwen', '${now}', '${now}');
      307|         `);
      308|       }).toThrow();
  ```

---

## Stream A — CDP Client & Window Lease Manager (`wt/junior-a-cdp`)

### Mutation A1: Remove `acquireLease` DB Exclusivity Guard
- **Guard Modified:** Removed `idx_window_leases_active` partial UNIQUE index check from [`engine/harness/lease-manager.ts`](file:///d:/Dept%20of%20code%20v2/engine/harness/lease-manager.ts).
- **Test Caught:** [`test/integration/t31_window_lease.test.ts`](file:///d:/Dept%20of%20code%20v2/test/integration/t31_window_lease.test.ts) > `enforces exclusivity, heartbeat extension, explicit release, and transactional reaping`
- **Failure Output:**
  ```text
  FAIL  test/integration/t31_window_lease.test.ts > T31: Window Lease Manager Integration Test (Stream A2) > enforces exclusivity, heartbeat extension, explicit release, and transactional reaping
  AssertionError: expected [Function] to throw LeaseError
  ```

---

### Mutation A2: Remove Browser Binary Discovery Guard
- **Guard Modified:** Removed binary discovery check in `findBrowserBinary()` in [`engine/harness/cdp-client.ts`](file:///d:/Dept%20of%20code%20v2/engine/harness/cdp-client.ts).
- **Test Caught:** [`test/integration/t30_cdp_client.test.ts`](file:///d:/Dept%20of%20code%20v2/test/integration/t30_cdp_client.test.ts) > `launches headless browser, navigates file:// page, reads/acts DOM, and closes cleanly`
- **Failure Output:**
  ```text
  FAIL  test/integration/t30_cdp_client.test.ts > T30: Hand-Rolled CDP Client Integration Test (Stream A1) > launches headless browser, navigates file:// page, reads/acts DOM, and closes cleanly
  HarnessError: No Chrome or Edge browser binary found. Please install Chrome or Edge to run harness tests.
  ```

---

### Mutation A3: Remove `finally` Lease Release in `dispatch-job.ts`
- **Guard Modified:** Removed `releaseLease(ctx.db, lease.id)` from `finally` block in [`engine/harness/dispatch-job.ts`](file:///d:/Dept%20of%20code%20v2/engine/harness/dispatch-job.ts).
- **Test Caught:** [`test/integration/t37_crash_safety.test.ts`](file:///d:/Dept%20of%20code%20v2/test/integration/t37_crash_safety.test.ts) > `handles mid-dispatch crash, reaps stale lease, re-drives safely, and releases lease on completion and failure`
- **Failure Output:**
  ```text
  FAIL  test/integration/t37_crash_safety.test.ts > T37: Crash Safety Integration Test (Stream A3) > handles mid-dispatch crash, reaps stale lease, re-drives safely, and releases lease on completion and failure
  AssertionError: expected 'active' to be 'released' // Object.is equality

  Expected: "released"
  Received: "active"

   ❯ test/integration/t37_crash_safety.test.ts:78:33
       76|     // Assert that handleJuniorDispatch released its window lease upon completion
       77|     const leaseAfter1 = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE dispatch_id = ?', 'disp-t37');
       78|     expect(leaseAfter1?.status).toBe('released');
  ```

---

## Stream B — Selector Registry, Calibration Gate, Nonce Correlation

### Mutation 1: Calibration Gate Check Removal (`t35_calibration_gate.test.ts`)
- **Guard Modified:** Commented out `this.checkGate(...)` calls in `GatedIdeDriver.read` and `GatedIdeDriver.act` in [`engine/selectors/gate.ts`](file:///d:/Dept%20of%20code%20v2/engine/selectors/gate.ts).
- **Test Caught:** [`test/integration/t35_calibration_gate.test.ts`](file:///d:/Dept%20of%20code%20v2/test/integration/t35_calibration_gate.test.ts)
- **Failure Output:**
  ```text
  FAIL  test/integration/t35_calibration_gate.test.ts > T35: Calibration Gate Integration Test > refuses actions on uncalibrated selectors, browser never sees them, and journals guardrail span
  AssertionError: promise resolved "{ success: true, …(1) }" instead of rejecting
   ❯ test/integration/t35_calibration_gate.test.ts:81:55
      81|     await expect(gatedDriver.act('btn.draft', 'click')).rejects.toThrow(UncalibratedSelectorError);
  ```

---

### Mutation 2: Calibration Match Count Equality Check Removal (`t33_calibration_fail.test.ts`)
- **Guard Modified:** Modified `if (readRes.matchCount !== 1)` to `if (false)` in `selectorCalibrateHandler()` in [`engine/selectors/registry.ts`](file:///d:/Dept%20of%20code%20v2/engine/selectors/registry.ts).
- **Test Caught:** [`test/integration/t33_calibration_fail.test.ts`](file:///d:/Dept%20of%20code%20v2/test/integration/t33_calibration_fail.test.ts)
- **Failure Output:**
  ```text
  FAIL  test/integration/t33_calibration_fail.test.ts > T33: Selector Calibration Fail Integration Test > fails calibration for an ambiguous selector and records evidence in job last_error and journal
  AssertionError: expected selector status 'calibrated' to be 'failed'
   ❯ test/integration/t33_calibration_fail.test.ts:86:31
      86|     expect(selector?.status).toBe('failed');
  ```
