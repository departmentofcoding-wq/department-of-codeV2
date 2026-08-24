status: 'Active' | 'Inactive';
created_at: string;
updated_at: string;
}
engine/db/schema.ts
In applySchema(db): Add CREATE TABLE IF NOT EXISTS bureau_assets:
sql
CREATE TABLE IF NOT EXISTS bureau_assets (
id TEXT PRIMARY KEY,
name TEXT NOT NULL,
category TEXT NOT NULL DEFAULT 'Other',
url TEXT NOT NULL,
description TEXT,
owner TEXT,
status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
);
Component 2: Console API Contract & Contract Tests (console/ & test/unit/)
console/contract.ts
Add DTOs:
AssetDTO (matches frontend representation with ISO timestamps)
CreateAssetRequest: { name: string; category?: string; url: string; description?: string; owner?: string; status?: 'Active' | 'Inactive'; }
UpdateAssetRequest: { name?: string; category?: string; url?: string; description?: string; owner?: string; status?: 'Active' | 'Inactive'; }
DeleteAssetResult: { ok: boolean; id: string; }
Add entries to ENDPOINTS: readonly ConsoleEndpointDef[]:
{ method: 'GET', path: '/api/assets', auth: 'token', description: 'List all department assets' }
{ method: 'POST', path: '/api/assets', auth: 'token', description: 'Create a new department asset' }
{ method: 'POST', path: '/api/assets/:id/update', auth: 'token', description: 'Update an existing department asset' }
{ method: 'POST', path: '/api/assets/:id/delete', auth: 'token', description: 'Delete a department asset' }
test/unit/contract_d0_c.test.ts
Update expect(ENDPOINTS.length).toBe(14) to toBe(18).
Add path expectations for GET /api/assets, POST /api/assets, POST /api/assets/:id/update, POST /api/assets/:id/delete.
Component 3: Console Backend Server (console/)
console/server.ts
Implement endpoint handlers behind x-console-token authentication:
GET /api/assets:
Queries SELECT * FROM bureau_assets ORDER BY updated_at DESC.
Returns array of AssetDTO with text fields scrubbed via redactOutput().
POST /api/assets:
Validates that name and url are present and non-empty. Returns 400 VALIDATION_ERROR if missing.
Safely defaults bindings:
category: body.category?.trim() || 'Other'
description: body.description?.trim() || null
owner: body.owner?.trim() || null
status: body.status === 'Inactive' ? 'Inactive' : 'Active'
Inserts row into bureau_assets with generated UUID (crypto.randomUUID()), created_at, updated_at.
Records journal entry: kind: 'human', attribution { actor_role: 'human-operator', provider: 'human', model: 'operator', account: 'operator' }, detail { action: 'asset_create', id: assetId, name }.
Returns 201 + AssetDTO.
POST /api/assets/:id/update:
Extracts :id from path. Checks asset existence (returns 404 NOT_FOUND if absent).
If name or url are supplied in body, validates they are non-empty strings (returns 400 VALIDATION_ERROR on blank values).
Safely resolves updated fields or keeps existing values, ensuring null (not undefined) for omitted optional values.
Updates row in bureau_assets, setting updated_at = new Date().toISOString().
Records journal entry: kind: 'human', detail { action: 'asset_update', id: assetId }.
Returns 200 + updated AssetDTO.
POST /api/assets/:id/delete:
Extracts :id from path. Checks asset existence (returns 404 NOT_FOUND if absent).
Deletes row from bureau_assets.
Records journal entry: kind: 'human', detail { action: 'asset_delete', id: assetId }.
Returns 200 { ok: true, id: assetId }.
Component 4: Frontend UI & Render Core (console/public/)
console/public/index.html
Add navigation tab: <button class="nav-tab" data-view="assets">Assets</button> in <nav class="nav">.
Add view container: <div id="view-assets" class="view-section"> with header, + Add Asset button, and <div id="assets-container">.
Add modal structure: <div id="asset-modal" class="modal-backdrop hidden"> containing form fields for Name, Category (select), URL, Description, Owner, Status (select: Active/Inactive), and Cancel / Save buttons.
console/public/render.js
Implement renderAssetsTable(assets: AssetDTO[]):
Formats table with columns: Asset Name, Category, URL (anchor tag with target="_blank" rel="noopener"), Description, Owner, Status (.badge.state-active / .badge.state-inactive), Last Updated, and Actions (.btn-edit-asset / .btn-delete-asset).
Renders empty state card if array is empty (No department assets tracked yet.).
HTML-escapes all dynamic fields using escapeHtml() to guarantee XSS prevention.
console/public/render.d.ts
Add type declaration: export function renderAssetsTable(assets: import('../contract.ts').AssetDTO[]): string;.
console/public/app.js
Add 'assets' tab handling to tab switching and polling loop (loadAssetsView()).
Wire + Add Asset button and row Edit buttons to populate and open #asset-modal.
Wire form submission with client-side validation, dispatching apiFetch('/api/assets', ...) or apiFetch('/api/assets/' + id + '/update', ...).
Wire Delete button to confirmation modal, dispatching apiFetch('/api/assets/' + id + '/delete', { method: 'POST' }).
Trigger immediate reload on successful mutations.
console/public/styles.css
Add styles for asset badges, asset category chips, external link styling, and modal form layout.
3. Tests and Mutation Evidence
Tests to Add & Update
test/unit/contract_d0_c.test.ts (Updated):
Updates endpoint length assertion to 18 and checks asset paths are declared.
test/unit/tc6_assets_api.test.ts (New):
1. GET /api/assets: verifies empty array response initially and verifies populated array sorted by updated_at DESC.
2. POST /api/assets: verifies successful creation of asset, category defaulting (Other), safe non-null bindings, SQLite persistence, valid journal entry attribution (kind: 'human'), and returns 201 + AssetDTO.
3. Validation Gate: verifies POST /api/assets and POST /api/assets/:id/update reject missing or whitespace-only name or url with HTTP 400 VALIDATION_ERROR.
4. POST /api/assets/:id/update: verifies modification of fields, updated_at refresh, safe handling of optional bindings, and returns 404 for non-existent asset IDs.
5. POST /api/assets/:id/delete: verifies asset deletion from SQLite and returns 404 for non-existent asset IDs.
6. Auth Guard: verifies all /api/assets endpoints fail-closed with HTTP 401 and log a guardrail journal span when x-console-token is missing or invalid.
7. Endpoint Manifest: verifies GET /api/assets, POST /api/assets, POST /api/assets/:id/update, and POST /api/assets/:id/delete exist in ENDPOINTS.
test/unit/tCONSOLE_assets_render.test.ts (New):
1. Table Rendering: verifies column headers, category badges, sanitized external link anchors, status badges, and action buttons.
2. XSS Prevention: verifies that malicious scripts (<script>alert(1)</script>, <img onerror=alert(1)>) in name, url, description, or owner are safely escaped.
3. Empty State: verifies empty state fallback markup.
Mutation Evidence Plan
M-ASSET-1 (Validation Guard):
Mutation: Remove the validation check if (!name?.trim() || !url?.trim()) in POST /api/assets.
Evidence: Test tc6_assets_api.test.ts ("Validation Gate: rejects missing or blank name or url") fails with HTTP 201 instead of 400.
M-ASSET-2 (Auth Guard):
Mutation: Bypass the reqToken !== token authentication check for /api/assets routes.
Evidence: Test tc6_assets_api.test.ts ("Auth Guard: /api/assets endpoints fail-closed (401)") fails with HTTP 200 instead of 401.
M-ASSET-3 (Timestamp Update Guard):
Mutation: Omit updating updated_at on POST /api/assets/:id/update.
Evidence: Test tc6_assets_api.test.ts ("POST /api/assets/:id/update refreshes updated_at timestamp") fails.
4. Walkthrough / Verification Plan
Automated Verification
Run npm run build (tsc --noEmit) to verify clean typechecking across engine, console, and tests.
Run targeted test suites:
bash
npx vitest run test/unit/contract_d0_c.test.ts
npx vitest run test/unit/tc6_assets_api.test.ts
npx vitest run test/unit/tCONSOLE_assets_render.test.ts
Run the full test suite (npx vitest run) to confirm zero regressions.
Execute mutation tests M-ASSET-1, M-ASSET-2, and M-ASSET-3, logging failure and recovery logs in docs/mutation-evidence-console.md.
Interactive / Manual Verification
Launch Console via npm run console.
Verify the Assets tab is visible in the top navigation bar.
Click + Add Asset, enter details:
Name: Google AI Studio Key Pool
Category: Google
URL: https://aistudio.google.com
Description: Primary API keys for flash-lite and flash models
Owner: operator
Status: Active
Click Save: confirm the asset row appears in the table.
Click Edit: change Status to Inactive and update description; verify updated timestamp.
Refresh the browser page: confirm all changes persist from SQLite.
Click Delete and confirm: verify the record is removed from the table.
Implementation Plan
Updated implementation plan for Department Assets tab resolving contract test assertions count (14 to 18) and category default / safe sqlite bind parameters.
Proceed
4:39 PM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Revised Implementation Plan (v2): Add 'Department Assets' Tab to Internal Dashboard This version addresses both points raised in the Senior review: Contract Test Scope: Added test/unit/contractd0c.test.ts to the Enumerable Scope to update the endpoint count assertion from 14 to 18 and assert the new asset route paths. Category Default & SQLite Bind Safety: Defined bureau_assets.category as TEXT NOT NULL DEFAULT 'Other' in SQL schema, and explicitly normalized optional fields in the server handler (category = body.category?.trim() || 'Other', description = body.description?.trim() || null, owner = body.owner?.trim() || null, status = body.status === 'Inactive' ? 'Inactive' : 'Active') so node:sqlite never receives an undefined bind argument. Branch Name wt/junior-assets-tab Enumerable Scope / Components and Files to Change Component 1: Database Schema & Contract Types (engine/) engine/contract/types.ts Add BureauAssetRow interface: [Code Block] engine/db/schema.ts In applySchema(db): Add CREATE TABLE IF NOT EXISTS bureau_assets: [Code Block] Component 2: Console API Contract & Contract Tests (console/ & test/unit/) console/contract.ts Add DTOs: AssetDTO (matches frontend representation with ISO timestamps) CreateAssetRequest: { name: string; category?: string; url: string; description?: string; owner?: string; status?: 'Active' | 'Inactive'; } UpdateAssetRequest: { name?: string; category?: string; url?: string; description?: string; owner?: string; status?: 'Active' | 'Inactive'; } DeleteAssetResult: { ok: boolean; id: string; } Add entries to ENDPOINTS: readonly ConsoleEndpointDef[]: { method: 'GET', path: '/api/assets', auth: 'token', description: 'List all department assets' } { method: 'POST', path: '/api/assets', auth: 'token', description: 'Create a new department asset' } { method: 'POST', path: '/api/assets/:id/update', auth: 'token', description: 'Update an existing department asset' } { method: 'POST', path: '/api/assets/:id/delete', auth: 'token', description: 'Delete a department asset' } test/unit/contractd0c.test.ts Update expect(ENDPOINTS.length).toBe(14) to toBe(18). Add path expectations for GET /api/assets, POST /api/assets, POST /api/assets/:id/update, POST /api/assets/:id/delete. Component 3: Console Backend Server (console/) console/server.ts Implement endpoint handlers behind x-console-token authentication: GET /api/assets: Queries SELECT FROM bureauassets ORDER BY updatedat DESC. Returns array of AssetDTO with text fields scrubbed via redactOutput(). POST /api/assets: Validates that name and url are present and non-empty. Returns 400 VALIDATION_ERROR if missing. Safely defaults bindings: category: body.category?.trim() || 'Other' description: body.description?.trim() || null owner: body.owner?.trim() || null status: body.status === 'Inactive' ? 'Inactive' : 'Active' Inserts row into bureauassets with generated UUID (crypto.randomUUID()), createdat, updated_at. Records journal entry: kind: 'human', attribution { actorrole: 'human-operator', provider: 'human', model: 'operator', account: 'operator' }, detail { action: 'assetcreate', id: assetId, name }. Returns 201 + AssetDTO. POST /api/assets/:id/update: Extracts :id from path. Checks asset existence (returns 404 NOT_FOUND if absent). If name or url are supplied in body, validates they are non-empty strings (returns 400 VALIDATION_ERROR on blank values). Safely resolves updated fields or keeps existing values, ensuring null (not undefined) for omitted optional values. Updates row in bureauassets, setting updatedat = new Date().toISOString(). Records journal entry: kind: 'human', detail { action: 'asset_update', id: assetId }. Returns 200 + updated AssetDTO. POST /api/assets/:id/delete: Extracts :id from path. Checks asset existence (returns 404 NOT_FOUND if absent). Deletes row from bureau_assets. Records journal entry: kind: 'human', detail { action: 'asset_delete', id: assetId }. Returns 200 { ok: true, id: assetId }. Component 4: Frontend UI & Render Core (console/public/) console/public/index.html Add navigation tab: Assets in . Add view container: with header, + Add Asset button, and . Add modal structure: containing form fields for Name, Category (select), URL, Description, Owner, Status (select: Active/Inactive), and Cancel / Save buttons. console/public/render.js Implement renderAssetsTable(assets: AssetDTO[]): Formats table with columns: Asset Name, Category, URL (anchor tag with target="_blank" rel="noopener"), Description, Owner, Status (.badge.state-active / .badge.state-inactive), Last Updated, and Actions (.btn-edit-asset / .btn-delete-asset). Renders empty state card if array is empty (No department assets tracked yet.). HTML-escapes all dynamic fields using escapeHtml() to guarantee XSS prevention. console/public/render.d.ts Add type declaration: export function renderAssetsTable(assets: import('../contract.ts').AssetDTO[]): string;. console/public/app.js Add 'assets' tab handling to tab switching and polling loop (loadAssetsView()). Wire + Add Asset button and row Edit buttons to populate and open #asset-modal. Wire form submission with client-side validation, dispatching apiFetch('/api/assets', ...) or apiFetch('/api/assets/' + id + '/update', ...). Wire Delete button to confirmation modal, dispatching apiFetch('/api/assets/' + id + '/delete', { method: 'POST' }). Trigger immediate reload on successful mutations. console/public/styles.css Add styles for asset badges, asset category chips, external link styling, and modal form layout. Tests and Mutation Evidence Tests to Add & Update test/unit/contractd0c.test.ts (Updated): Updates endpoint length assertion to 18 and checks asset paths are declared. test/unit/tc6assetsapi.test.ts (New): GET /api/assets: verifies empty array response initially and verifies populated array sorted by updated_at DESC. POST /api/assets: verifies successful creation of asset, category defaulting (Other), safe non-null bindings, SQLite persistence, valid journal entry attribution (kind: 'human'), and returns 201 + AssetDTO. Validation Gate: verifies POST /api/assets and POST /api/assets/:id/update reject missing or whitespace-only name or url with HTTP 400 VALIDATION_ERROR. POST /api/assets/:id/update: verifies modification of fields, updated_at refresh, safe handling of optional bindings, and returns 404 for non-existent asset IDs. POST /api/assets/:id/delete: verifies asset deletion from SQLite and returns 404 for non-existent asset IDs. Auth Guard: verifies all /api/assets endpoints fail-closed with HTTP 401 and log a guardrail journal span when x-console-token is missing or invalid. Endpoint Manifest: verifies GET /api/assets, POST /api/assets, POST /api/assets/:id/update, and POST /api/assets/:id/delete exist in ENDPOINTS. test/unit/tCONSOLEassetsrender.test.ts (New): Table Rendering: verifies column headers, category badges, sanitized external link anchors, status badges, and action buttons. XSS Prevention: verifies that malicious scripts (alert(1), ) in name, url, description, or owner are safely escaped. Empty State: verifies empty state fallback markup. Mutation Evidence Plan M-ASSET-1 (Validation Guard): Mutation*: Remove the validation check if (!name?.trim() || !url?.trim()) in POST /api/assets. Evidence*: Test tc6assetsapi.test.ts ("Validation Gate: rejects missing or blank name or url") fails with HTTP 201 instead of 400. M-ASSET-2 (Auth Guard): Mutation*: Bypass the reqToken !== token authentication check for /api/assets routes. Evidence*: Test tc6assetsapi.test.ts ("Auth Guard: /api/assets endpoints fail-closed (401)") fails with HTTP 200 instead of 401. M-ASSET-3 (Timestamp Update Guard): Mutation*: Omit updating updated_at on POST /api/assets/:id/update. Evidence*: Test tc6assetsapi.test.ts ("POST /api/assets/:id/update refreshes updated_at timestamp") fails. Walkthrough / Verification Plan Automated Verification Run npm run build (tsc --noEmit) to verify clean typechecking across engine, console, and tests. Run targeted test suites: [Code Block] Run the full test suite (npx vitest run) to confirm zero regressions. Execute mutation tests M-ASSET-1, M-ASSET-2, and M-ASSET-3, logging failure and recovery logs in docs/mutation-evidence-console.md. Interactive / Manual Verification Launch Console via npm run console. Verify the Assets tab is visible in the top navigation bar. Click + Add Asset, enter details: Name: Google AI Studio Key Pool Category: Google URL: https://aistudio.google.com Description: Primary API keys for flash-lite and flash models Owner: operator Status: Active Click Save: confirm the asset row appears in the table. Click Edit: change Status to Inactive and update description; verify updated timestamp. Refresh the browser page: confirm all changes persist from SQLite. Click Delete and confirm: verify the record is removed from the table.
4:44 PM
Worked for 5m
I have launched the full test suite (npx vitest run) to verify all unit and integration tests across the codebase. I will wait for it to complete.
12 files changed
+931
-2
Review
4:44 PM
12 Files With Changes
Reject all
Accept all
+12
-0
types.ts
d:\Dept of code v2\engine\contract\types.ts
+12
-0
schema.ts
d:\Dept of code v2\engine\db\schema.ts
+62
-0
contract.ts
d:\Dept of code v2\console\contract.ts
+6
-1
contract_d0_c.test.ts
d:\Dept of code v2\test\unit\contract_d0_c.test.ts
+200
-1
server.ts
d:\Dept of code v2\console\server.ts
+63
-0
index.html
d:\Dept of code v2\console\public\index.html
+61
-0
render.js
d:\Dept of code v2\console\public\render.js
+3
-0
render.d.ts
d:\Dept of code v2\console\public\render.d.ts
+132
-0
app.js
d:\Dept of code v2\console\public\app.js
+29
-0
styles.css
d:\Dept of code v2\console\public\styles.css
+262
-0
tc6_assets_api.test.ts
d:\Dept of code v2\test\unit\tc6_assets_api.test.ts
+87
-0
tCONSOLE_assets_render.test.ts
d:\Dept of code v2\test\unit\tCONSOLE_assets_render.test.ts
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
I have launched the full test suite (npx vitest run) to verify all unit and integration tests across the codebase. I will wait for it to complete.
