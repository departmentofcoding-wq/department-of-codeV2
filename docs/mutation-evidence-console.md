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

---

## M-B1: Render Core HTML Escaping / XSS Guard (`console/public/render.js`)

- **Branch / Milestone**: `wt/junior-b-console` (Milestone B1)
- **Guard Broken**: `escapeHtml` pass in `console/public/render.js:13`.
- **Mutation Applied**: Removed string escaping in `escapeHtml`, returning raw unescaped string.
- **Test Command**: `npx vitest run test/unit/tCONSOLE_b1_render.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/tCONSOLE_b1_render.test.ts > Milestone B1 — UI Shell & Testable Render Core (T-C4) > 2. renderDashboardTileGrid: formats state populations, budget spend, failure rate, and guardrails
  AssertionError: expected '\n    <div class="dashboard-grid">\n…' to contain '&lt;script&gt;alert(&#39;xss&#39;)&lt…'
  ```
- **Verification**: Mutation caught by `test/unit/tCONSOLE_b1_render.test.ts`. Restored code passes cleanly.

---

## M-B2: View Field Mapping & Error Envelope Guard (`console/public/render.js`)

- **Branch / Milestone**: `wt/junior-b-console` (Milestone B2)
- **Guard Broken**: `renderErrorToast` error envelope code formatting in `console/public/render.js:235`.
- **Mutation Applied**: Changed `[${error.code}]` formatting to return empty string instead of error code.
- **Test Command**: `npx vitest run test/unit/tCONSOLE_b2_views.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/tCONSOLE_b2_views.test.ts > Milestone B2 — Views Wired to Read APIs (T-C5) > 3. Error Envelope Rendering: ApiErrorResponse renders structured error view, never blank screen
  AssertionError: expected '<div class="toast toast-error">…' to contain 'UNVERIFIED_APPROVAL_REFUSED'
  ```
- **Verification**: Mutation caught by `test/unit/tCONSOLE_b2_views.test.ts`. Restored code passes cleanly.

---

## M-B3: Tokenized Launch URL Query Parameter Guard (`scripts/console.ts`)

- **Branch / Milestone**: `wt/junior-b-console` (Milestone B3)
- **Guard Broken**: `buildLaunchUrl` URL query parameter token format in `scripts/console.ts:24`.
- **Mutation Applied**: Removed `?token=` parameter from constructed launch URL, returning `http://127.0.0.1:3100/`.
- **Test Command**: `npx vitest run test/unit/tCONSOLE_b3_launcher_shortcut.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/tCONSOLE_b3_launcher_shortcut.test.ts > Milestone B3 — Action UX & Desktop Shortcut Launcher (T-C6) > 1. Token Minting & URL Format: mints 32-byte hex token and formats localhost URL
  AssertionError: expected 'http://127.0.0.1:3100/' to be 'http://127.0.0.1:3100/?token=e481827f…'
  ```
- **Verification**: Mutation caught by `test/unit/tCONSOLE_b3_launcher_shortcut.test.ts`. Restored code passes cleanly.
