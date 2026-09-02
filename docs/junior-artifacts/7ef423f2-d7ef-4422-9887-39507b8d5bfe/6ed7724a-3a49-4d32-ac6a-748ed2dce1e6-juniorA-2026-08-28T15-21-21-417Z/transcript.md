File
Edit
Selection
View
Go
Run
Terminal
Help
7ef423f2-d7ef-4422-9887-39507b8d5bfe - Antigravity IDE
2
Explorer
7ef423f2-d7ef-4422-9887-39507b8d5bfe
console
docs
engine
node_modules
runner
scripts
test
.gitignore
AGENTS.md
package-lock.json
package.json
tsconfig.json
vitest.config.ts
Outline
Timeline
Antigravity IDE
Code with Agent
Ctrl
+
L
bureau-wt-7ef423f2-d7ef-4422-9887-39507b8d5bfe*
0
0
Antigravity - Settings
Harden POSIX Process Killing
No more older messages
Your implementation plan was reviewed and APPROVED by a senior. Implement it now, exactly as planned.
Rules: work directly on the branch already checked out in the worktree (bureau-wt-7ef423f2-d7ef-4422-9887-39507b8d5bfe); do not create, switch, or rename branches; add the tests the plan names; when done, finish with a walkthrough section summarizing what changed, the test results, and the verification you ran.
===== TASK =====
TITLE: Harden killProcessesByImageName POSIX kill against over-matching
INTENT: engine/harness/process-control.ts buildKillProcessCommand uses 'pkill -f "<exe>"' on non-Windows, which matches the FULL command line and can kill unrelated processes that merely mention the exe name in their arguments. Make the POSIX kill match the process image name exactly instead, keeping the Windows 'taskkill /IM "<exe>" /F' path unchanged. This is pre-Phase-8 hardening item P2.3 from docs/plan-pre-phase8-remaining.md.
SPEC: In engine/harness/process-control.ts, change buildKillProcessCommand so the non-win32 branch does an EXACT image-name match (e.g. 'pkill -x "<name>"' where <name> is the process/image basename) rather than the substring-prone 'pkill -f'. Windows branch unchanged. Update the buildKillProcessCommand assertion in test/unit/tc_senior_resilience.test.ts to expect the new POSIX form. Keep killProcessesByImageName best-effort (still swallows all errors).
ACCEPTANCE: npm run build clean; npm test green; buildKillProcessCommand on a non-win32 platform no longer emits a bare 'pkill -f' substring match and instead matches the image name exactly; the Windows path still emits 'taskkill /IM "<name>" /F'; a unit test asserts the new POSIX command form.
===== SENIOR'S FINAL REQUIRED CHANGES =====
VERDICT: APPROVE
The plan matches the task precisely:
- **Core change is correct**: `pkill -f "${exeName}"` → `pkill -x "${exeName}"` on non-win32, Windows branch (`taskkill /IM "${exeName}" /F`) untouched — exactly what the spec asks for. I confirmed via `senior.ts`/`antigravity.ts` that `buildKillProcessCommand`/`killProcessesByImageName` are only ever called with an already-resolved basename (`seniorProcessImageName`/`juniorProcessImageName` → `processImageName`), so `pkill -x` on the raw `exeName` is safe — no need to re-derive a basename inside the function itself.
- **Test update is correct**: updates the existing WS1 assertion to expect `pkill -x "Antigravity IDE.exe"`.
- **Good catch beyond the literal spec**: this dev environment is Windows (`process.platform === 'win32'`), so the existing test's `if (win32) {...} else {...}` only ever exercises the `taskkill` branch here and locally would never actually verify the new POSIX form. The plan's addition of `process.platform`-mocked tests (linux/darwin forcing the pkill branch, win32 forcing taskkill) is necessary, not optional, to actually satisfy the acceptance criterion "a unit test asserts the new POSIX command form" on this machine. No prior art for platform-mocking exists in this repo, so watch during implementation that it uses a safe pattern (`Object.defineProperty(process, 'platform', { value, configurable: true })` + restore in `afterEach`) rather than a bare reassignment that could leak across tests.
- **Error-swallowing / best-effort contract**: plan correctly leaves `killProcessesByImageName`'s error handling untouched, no changes needed there.
- Mutation-testing evidence plan and build/test verification steps are reasonable and match the acceptance bar (build clean, full suite green).
No scope creep, no missed call sites, no over-broad changes. Proceed.
===== APPROVED PLAN =====
8:47 PM
Worked for 10s
Implementation Plan
1. Branch and Worktree Context
Worktree Target Branch: Work directly on the branch already checked out in the worktree: bureau-wt-7ef423f2-d7ef-4422-9887-39507b8d5bfe.
Branch Policy: No new branches will be created, switched, or renamed. All edits, test runs, and verification steps will take place within this worktree.
2. Enumerable Scope (Components and Files to Change)
Component: Process Control Harness (engine/harness)
[MODIFY]
engine/harness/process-control.ts
Update buildKillProcessCommand(exeName: string): string to use exact image-name matching on POSIX (pkill -x "${exeName}") instead of full command-line substring matching (pkill -f "${exeName}").
Keep the Windows branch unchanged: taskkill /IM "${exeName}" /F.
Maintain the error-swallowing contract in killProcessesByImageName(exeName: string): execution errors and non-zero exit codes (e.g. process not found, permission denied, missing pkill) are swallowed and never throw.
Component: Senior Resilience Unit Tests (test/unit)
[MODIFY]
test/unit/tc_senior_resilience.test.ts
Update the existing test WS1 — senior process image + kill command (pure) > buildKillProcessCommand force-kills by image name and quotes names with spaces to expect pkill -x "Antigravity IDE.exe" when process.platform !== 'win32'.
Add explicit unit tests verifying:
POSIX command generation emits pkill -x "<image>" for both single-word executables and executables with spaces.
Windows command generation emits taskkill /IM "<image>" /F for both single-word executables and executables with spaces.
killProcessesByImageName completes without throwing across platforms.
3. Tests to Add and Mutation Evidence to Record
Unit Test Additions & Updates
In test/unit/tc_senior_resilience.test.ts:
Update existing assertion:
ts
// Non-win32 expectation
expect(buildKillProcessCommand('Antigravity IDE.exe')).toBe('pkill -x "Antigravity IDE.exe"');
Add deterministic platform-mocked tests:
Temporarily mock process.platform = 'linux' / 'darwin' to assert that buildKillProcessCommand('ZCode') returns pkill -x "ZCode" and buildKillProcessCommand('Antigravity IDE.exe') returns pkill -x "Antigravity IDE.exe".
Temporarily mock process.platform = 'win32' to assert that buildKillProcessCommand('ZCode.exe') returns taskkill /IM "ZCode.exe" /F.
Mutation Evidence Plan
To prove the tests are sensitive and accurately catch regressions or improper implementations:
Mutation 1 (Revert to -f):
Mutation: Change pkill -x back to pkill -f.
Expected Result: The unit test fails expecting pkill -x "..." but receiving pkill -f "...".
Mutation 2 (Bare pkill without -x):
Mutation: Remove -x flag (producing pkill "...").
Expected Result: The unit test fails with a string mismatch.
Mutation 3 (Windows Flag Alteration):
Mutation: Change /IM or /F in the Windows branch (e.g. taskkill /PID ...).
Expected Result: The Windows unit test assertion fails with a string mismatch.
Mutation 4 (Throwing on Error in killProcessesByImageName):
Mutation: Remove .on('error', () => resolve()) or reject on exec error.
Expected Result: killSeniorProcesses never throws, even for an image that does not exist test fails.
All mutation run outputs will be captured and documented as evidence in the walkthrough artifact.
4. Walkthrough / Verification Plan
Automated Verification
Targeted Unit Test Verification:
bash
npx vitest run test/unit/tc_senior_resilience.test.ts
Pass Criteria: All tests in tc_senior_resilience.test.ts pass cleanly (17+ tests).
TypeScript Clean Compilation:
bash
npm run build
Pass Criteria: TypeScript build succeeds with exit code 0 and no type errors.
Full Department Test Suite:
bash
npm test
Pass Criteria: All 109+ test suites and 579+ test cases across unit and integration suites pass (100% green).
Walkthrough Artifact & Inspection
Record before/after diffs of engine/harness/process-control.ts and test/unit/tc_senior_resilience.test.ts.
Document mutation test runs demonstrating that tests fail under intentional code mutations.
Verify that docs/plan-pre-phase8-remaining.md item P2.3 requirements are completely met.
Write final results, diffs, and verification logs to walkthrough.md.
Implementation Plan
Comprehensive implementation plan for hardening killProcessesByImageName / buildKillProcessCommand against over-matching on POSIX platforms, with detailed scope, test specifications, mutation evidence plan, and walkthrough / verification plan.
Proceed
8:47 PM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Implementation Plan Branch and Worktree Context Worktree Target Branch: Work directly on the branch already checked out in the worktree: bureau-wt-7ef423f2-d7ef-4422-9887-39507b8d5bfe. Branch Policy: No new branches will be created, switched, or renamed. All edits, test runs, and verification steps will take place within this worktree. Enumerable Scope (Components and Files to Change) Component: Process Control Harness (engine/harness) [MODIFY] engine/harness/process-control.ts Update buildKillProcessCommand(exeName: string): string to use exact image-name matching on POSIX (pkill -x "${exeName}") instead of full command-line substring matching (pkill -f "${exeName}"). Keep the Windows branch unchanged: taskkill /IM "${exeName}" /F. Maintain the error-swallowing contract in killProcessesByImageName(exeName: string): execution errors and non-zero exit codes (e.g. process not found, permission denied, missing pkill) are swallowed and never throw. Component: Senior Resilience Unit Tests (test/unit) [MODIFY] test/unit/tcseniorresilience.test.ts Update the existing test WS1 — senior process image + kill command (pure) > buildKillProcessCommand force-kills by image name and quotes names with spaces to expect pkill -x "Antigravity IDE.exe" when process.platform !== 'win32'. Add explicit unit tests verifying: POSIX command generation emits pkill -x "" for both single-word executables and executables with spaces. Windows command generation emits taskkill /IM "" /F for both single-word executables and executables with spaces. killProcessesByImageName completes without throwing across platforms. Tests to Add and Mutation Evidence to Record Unit Test Additions & Updates In test/unit/tcseniorresilience.test.ts: Update existing assertion: [Code Block] Add deterministic platform-mocked tests: Temporarily mock process.platform = 'linux' / 'darwin' to assert that buildKillProcessCommand('ZCode') returns pkill -x "ZCode" and buildKillProcessCommand('Antigravity IDE.exe') returns pkill -x "Antigravity IDE.exe". Temporarily mock process.platform = 'win32' to assert that buildKillProcessCommand('ZCode.exe') returns taskkill /IM "ZCode.exe" /F. Mutation Evidence Plan To prove the tests are sensitive and accurately catch regressions or improper implementations: Mutation 1 (Revert to -f): Mutation: Change pkill -x back to pkill -f. Expected Result: The unit test fails expecting pkill -x "..." but receiving pkill -f "...". Mutation 2 (Bare pkill without -x): Mutation: Remove -x flag (producing pkill "..."). Expected Result: The unit test fails with a string mismatch. Mutation 3 (Windows Flag Alteration): Mutation: Change /IM or /F in the Windows branch (e.g. taskkill /PID ...). Expected Result: The Windows unit test assertion fails with a string mismatch. Mutation 4 (Throwing on Error in killProcessesByImageName): Mutation: Remove .on('error', () => resolve()) or reject on exec error. Expected Result: killSeniorProcesses never throws, even for an image that does not exist test fails. All mutation run outputs will be captured and documented as evidence in the walkthrough artifact. Walkthrough / Verification Plan Automated Verification Targeted Unit Test Verification: npx vitest run test/unit/tcseniorresilience.test.ts Pass Criteria: All tests in tcseniorresilience.test.ts pass cleanly (17+ tests). TypeScript Clean Compilation: npm run build Pass Criteria: TypeScript build succeeds with exit code 0 and no type errors. Full Department Test Suite: npm test Pass Criteria: All 109+ test suites and 579+ test cases across unit and integration suites pass (100% green). Walkthrough Artifact & Inspection Record before/after diffs of engine/harness/process-control.ts and test/unit/tcseniorresilience.test.ts. Document mutation test runs demonstrating that tests fail under intentional code mutations. Verify that docs/plan-pre-phase8-remaining.md item P2.3 requirements are completely met. Write final results, diffs, and verification logs to walkthrough.md.
8:49 PM
Worked for 30s
Running the test suite to establish baseline...
Run vitest tc_senior_resilience.test.ts finished
Worked for 1m
Running npm run build...
npm run build finished
Worked for 10s
Running the full test suite (npm test)...
2 files changed
+23
-3
Review
8:49 PM
2 Files With Changes
Reject all
Accept all
+1
-1
process-control.ts
d:\Dept of code v2\.bureau-worktrees\7ef423f2-d7ef-4422-9887-39507b8d5bfe\engine\harness\process-control.ts
+21
-1
tc_senior_resilience.test.ts
d:\Dept of code v2\.bureau-worktrees\7ef423f2-d7ef-4422-9887-39507b8d5bfe\test\unit\tc_senior_resilience.test.ts
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Running the test suite to establish baseline...
