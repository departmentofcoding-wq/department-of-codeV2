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
