# Operator Console Mutation Evidence Ledger

Every PR in the Operator Console track records the guard it broke and the test that caught it, proving real mutation testing was performed on the stream branch before submission for Senior Review.

---

## M-D0-C: Contract Freeze — Console Manifest Endpoint Auth Guard

- **Branch / Milestone**: `wt/junior-a-d0c` (Milestone D0-C)
- **Guard Broken**: Token authentication guard for `/api/health` endpoint manifest in `console/contract.ts`
- **Mutation Applied**: Changed `auth: 'token'` to `auth: 'public'` for `/api/health` in `ENDPOINTS` manifest (`console/contract.ts`).
- **Test Command**: `npx vitest run test/unit/contract_d0_c.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/contract_d0_c.test.ts > Milestone D0-C — Console Contract Freeze > 2. Endpoint Manifest: every endpoint declares method, path, description, and token auth
  AssertionError: expected 'public' to be 'token' // Object.is equality

  Expected: "token"
  Received: "public"

   ❯ test/unit/contract_d0_c.test.ts:35:23
       33| 
       34|     for (const ep of ENDPOINTS) {
       35|       expect(ep.auth).toBe('token');
         |                       ^
       36|       expect(ep.description).toBeTruthy();
       37|       expect(['GET', 'POST']).toContain(ep.method);
  ```
- **Verification**: Mutation caught by `test/unit/contract_d0_c.test.ts`. Restored code passes all 4 tests cleanly.
