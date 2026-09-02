walkthrough artifact
.
Key Accomplishments
Modal Mode Switch ("Register Existing" vs "Create New"):
Updated
index.html
and
app.js
with tab toggling between registering existing directories on disk and provisioning new repositories with configurable visibility (private, public, internal).
Backend API Endpoints:
POST /api/projects/provision: Enqueues a project.provision background job with deterministic ID project.provision:<canonicalName>, journals human operator action project_provision_enqueued, and returns HTTP 202 Accepted.
GET /api/settings/github: Returns masked status { authenticated, login, scopes, projects_root, repo_prefix } via getRepoProvider().getAuthStatus().
GET /api/journal?job_id=<jobId>: Added job_id query filtering in
queries.ts
and
server.ts
.
In-Flight Status Chips & Active Polling:
Implemented renderProvisioningChip in
render.js
with .chip-provisioning (pulse animation), .chip-done, and .chip-failed states.
Client automatically polls the journal every 2s until project-provisioned or guardrail failure is received, reloads the table, and auto-dismisses the chip.
Settings View GitHub Connection Card:
Displays connection status badge (Connected / Disconnected), @login, token scopes badges, projects root path, and repo prefix.
Contract Manifest Freeze:
ENDPOINTS in
contract.ts
and
contract_d0_c.test.ts
updated to freeze at 33 token-guarded endpoints.
Verification Summary
Targeted Unit Tests:
test/unit/contract_d0_c.test.ts (4/4 passed)
test/unit/tc7_projects_api.test.ts (13/13 passed)
test/unit/tCONSOLE_projects_render.test.ts (5/5 passed)
test/unit/tc_project_provisioning.test.ts (9/9 passed)
Full Suite Run Twice:
npm run build (tsc --noEmit): 0 errors
npx vitest run: 105 test files, 528 tests passing (100% green on consecutive runs)
Mutation Evidence (5/5 Recorded) in
mutation-evidence-phase8.md
:
M-PROV-CONSOLE-1: Manifest freeze catching missing provision endpoint
M-PROV-CONSOLE-2: Deterministic job ID derivation catching random UUID replacement
M-PROV-CONSOLE-3: Project name validation gate catching empty/blank bypass
M-PROV-CONSOLE-4: Masked GitHub connection status retrieval catching hardcoded disconnect
M-PROV-CONSOLE-5: Status chip CSS class rendering catching missing state class
Walkthrough
Walkthrough for Phase 8 Entry Stream B: Provisioning Console (the console half of the self-serve project provisioning engine). Details all contract changes, backend endpoints, frontend UI additions, test results, and 5 recorded mutations.
16 files changed
+992
-29
Review
16 Files With Changes
Reject all
Accept all
+8
-0
types.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\engine\contract\types.ts
+44
-0
repo_provider.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\engine\projects\repo_provider.ts
+11
-1
fake_repo_provider.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\test\helpers\fake_repo_provider.ts
+38
-0
contract.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\contract.ts
+3
-1
contract_d0_c.test.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\test\unit\contract_d0_c.test.ts
+88
-2
server.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\server.ts
+16
-3
index.html
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\public\index.html
+6
-2
render.d.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\public\render.d.ts
+91
-1
render.js
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\public\render.js
+61
-0
styles.css
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\public\styles.css
+140
-4
app.js
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\console\public\app.js
+287
-3
tc7_projects_api.test.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\test\unit\tc7_projects_api.test.ts
+60
-5
tCONSOLE_projects_render.test.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\test\unit\tCONSOLE_projects_render.test.ts
+4
-0
queries.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\engine\journal\queries.ts
+35
-1
provision.ts
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\engine\projects\provision.ts
+92
-0
mutation-evidence-phase8.md
d:\Dept of code v2\.bureau-worktrees\1429a7de-1bb0-4daf-8d4a-84850997eb26\docs\mutation-evidence-phase8.md

---
## Operator fix-round (addressing the zai REVISE)
The prior senior review (VERDICT: REVISE) raised two concrete items; both are now fixed in the worktree:
1. **Endpoint count reconciled explicitly.** Frozen at 33 (not the task's stale 32): base was 31 after the agent task-filing door (POST /api/tasks/file, 67eb81f) + 2 new (GET /api/settings/github, POST /api/projects/provision). Reconciliation notes added in console/contract.ts and test/unit/contract_d0_c.test.ts.
2. **Provisioning chip no longer polls forever.** startProvisioningPoll now also terminates on a terminal system/action:fail span (what failJob writes on a non-guardrail crash), plus a 5-minute safety cap. See console/public/app.js.
