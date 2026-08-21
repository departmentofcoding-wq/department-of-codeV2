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

## M-A1: Loopback-only bind host guard (`console/server.ts`)

- **Branch / Milestone**: `wt/junior-a-console` (Milestone A1)
- **Guard Broken**: Loopback host validation in `createConsoleServer` (`console/server.ts:140`).
- **Mutation Applied**: Bypassed host check by replacing condition with `if (false)`.
- **Test Command**: `npx vitest run test/unit/tc1_server.test.ts`
- **Result Output**:
  ```
   ❯ test/unit/tc1_server.test.ts (5 tests | 1 failed) 293ms
     × T-C1: Console HTTP Server Skeleton & Auth (Milestone A1) > refuses to bind to non-loopback host (e.g. 0.0.0.0) 93ms
       → promise resolved "{ server: Server{ … }, host: "127.0.0.1", port: 49816 }" instead of rejecting
  ```

---

## M-A2: Secret Output Redaction Guard (`console/server.ts`)

- **Branch / Milestone**: `wt/junior-a-console` (Milestone A2)
- **Guard Broken**: `redactOutput(t.title)` pass on task summaries in `GET /api/tasks` handler (`console/server.ts:213`).
- **Mutation Applied**: Removed `redactOutput` pass, returning unredacted `t.title`.
- **Test Command**: `npx vitest run test/unit/tc2_read_api.test.ts`
- **Result Output**:
  ```
   ❯ test/unit/tc2_read_api.test.ts (3 tests | 1 failed) 117ms
     × T-C2: Console Read Endpoints (Milestone A2) > guarantees planted secret never appears in any read response 32ms
       → expected '[{"id":"task-secret-1","title":"Fix task with secret bureau-secret-api-key-998877"...}]' not to contain 'bureau-secret-api-key-998877'
  ```

---

## M-A3: Non-Interactive Approval Core Invariant (`console/server.ts`)

- **Branch / Milestone**: `wt/junior-a-console` (Milestone A3)
- **Guard Broken**: Calling `approveTask(db, taskId, attribution)` single-writer in `POST /api/tasks/:id/approve` handler (`console/server.ts:314`).
- **Mutation Applied**: Replaced `approveTask` core call with a raw SQL `UPDATE bureau_tasks SET state = 'done'` bypassing single-writer invariant checks.
- **Test Command**: `npx vitest run test/unit/tc3_action_api.test.ts`
- **Result Output**:
  ```
   ❯ test/unit/tc3_action_api.test.ts (4 tests | 1 failed) 98ms
     × T-C3: Console Action Endpoints & Approval Core (Milestone A3) > approves a verified task: sets approval columns, retains state needs-review, enqueues pr.create, and journals human span 24ms
       → AssertionError: expected 'done' to be 'needs-review' // Object.is equality
  ```

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

---

## M-INTAKE-1: Human Verify-Confirm Gate on Task Filing (`console/server.ts`)

- **Branch / Milestone**: `wt/junior-console-intake` (Conversational Intake front door)
- **Guard Broken**: The human-operator confirm gate in the `POST /api/intake/:id/confirm-file` handler — `confirmVerify(db, sessionId, CONSOLE_HUMAN_ATTR)` before `fileTask`.
- **Mutation Applied**: Removed the `confirmVerify` call so filing proceeds without human confirmation of the officer-drafted verify command.
- **Test Command**: `npx vitest run test/unit/tc4_intake_api.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/tc4_intake_api.test.ts > T-C4 > drafts the verify command via the officer, then files on human confirm
  AssertionError: expected 400 to be 200
  ```
  (`fileTask` refuses on the `verify_confirmed` gap in `taskGaps`, so filing 400s instead of 200 — the operator's confirmation is load-bearing.)
- **Verification**: Mutation caught by `test/unit/tc4_intake_api.test.ts`. Restored code passes cleanly (7/7).

---

## M-INTAKE-2: Inline Officer-Turn Failure Surfacing (`console/server.ts`)

- **Branch / Milestone**: `wt/junior-console-intake` (Conversational Intake front door)
- **Guard Broken**: `runIntakeTurn` re-reads the drained `intake.turn` job and maps a non-`done` state to a failure. `drainSingleJob` swallows handler errors into the job row, so without this check a failed officer turn would be reported to the operator as success.
- **Mutation Applied**: Returned `{ ok: true }` for a non-`done` job instead of `{ ok: false, error }`.
- **Test Command**: `npx vitest run test/unit/tc4_intake_api.test.ts`
- **Result Output**:
  ```
  FAIL  test/unit/tc4_intake_api.test.ts > T-C4 > surfaces a failed officer turn as 502 with a guardrail span
  AssertionError: expected 200 to be 502
  ```
- **Verification**: Mutation caught by `test/unit/tc4_intake_api.test.ts`. Restored code passes cleanly (7/7).
