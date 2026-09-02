File
Edit
Selection
View
Go
Run
Terminal
Help
5d29e47b-b423-4223-bfd5-69dfbbf913cb - Antigravity IDE
2
Explorer
5d29e47b-b423-4223-bfd5-69dfbbf913cb
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
bureau-wt-5d29e47b-b423-4223-bfd5-69dfbbf913cb*
0
0
Antigravity - Settings
Implement Scale-Aware Senior Assignment
No more older messages
Your implementation plan was reviewed and APPROVED by a senior. Implement it now, exactly as planned.
Rules: work directly on the branch already checked out in the worktree (bureau-wt-5d29e47b-b423-4223-bfd5-69dfbbf913cb); do not create, switch, or rename branches; add the tests the plan names; when done, finish with a walkthrough section summarizing what changed, the test results, and the verification you ran.
===== TASK =====
TITLE: Scale-aware senior assignment: a concurrency default that prefers the parallelizable claude senior
INTENT: Phase 8 runs many tasks concurrently. The single ZCode/zai instance serializes all its reviews behind the WS4b mutex, and zai has quota limits; the claude senior is a subprocess and parallelizes freely. Make senior assignment scale-aware: under an opt-in concurrency setting, default reviews to a chosen senior (e.g. claude), while preserving all existing explicit overrides. Pre-Phase-8 item P1.1 from docs/plan-pre-phase8-remaining.md.
SPEC: In engine/harness/senior.ts, add an opt-in concurrency default read from a NEW env var SENIOR_SCALE_DEFAULT (a senior id). Precedence for assignSenior({kind}) and assignSeniorForTask(taskId): (1) explicit SENIOR_DEFAULT or the per-kind SENIOR_PLAN/SENIOR_WALKTHROUGH override wins; else (2) SENIOR_SCALE_DEFAULT if set; else (3) the existing hardcoded defaults (plan->claude, walkthrough->zai). Keep the functions pure/deterministic. Do NOT change any other behavior. Add unit tests in test/unit/tc_senior.test.ts covering the full precedence ladder.
ACCEPTANCE: npm run build clean; npm test green. With SENIOR_SCALE_DEFAULT=claude and no other senior env set, assignSenior({kind:'plan'}) and assignSenior({kind:'walkthrough'}) and assignSeniorForTask(id) all return 'claude'. An explicit SENIOR_DEFAULT or SENIOR_PLAN/SENIOR_WALKTHROUGH still wins over SENIOR_SCALE_DEFAULT. With NOTHING set, behavior is unchanged (plan->claude, walkthrough->zai). Unit tests assert each rung of the precedence.
===== SENIOR'S FINAL REQUIRED CHANGES =====
VERDICT: APPROVE
The plan correctly scopes to the two functions the spec names and matches the required precedence exactly:
- `assignSenior`: per-kind (`SENIOR_PLAN`/`SENIOR_WALKTHROUGH`) or global `SENIOR_DEFAULT` → `SENIOR_SCALE_DEFAULT` → hardcoded fallback (plan→claude, walkthrough→zai) → `resolveSenior(id).id`. This is a straightforward insertion into the existing `(perKind || global || fallback)` chain: `(perKind || global || scaleDefault || fallback)`.
- `assignSeniorForTask`: `SENIOR_DEFAULT` explicit override → `SENIOR_SCALE_DEFAULT` → existing deterministic hash. Also a clean insertion before the hash branch.
Both ladders match the spec's stated precedence (explicit wins > scale default > hardcoded), and the plan correctly notes there's no per-kind override applicable to `assignSeniorForTask` since it takes no `kind` param — consistent with the current code.
Test plan covers all three ACCEPTANCE rungs (nothing set → unchanged baseline; `SENIOR_SCALE_DEFAULT=claude` alone → claude for `assignSenior({kind:'plan'})`, `assignSenior({kind:'walkthrough'})`, and `assignSeniorForTask`; explicit `SENIOR_DEFAULT`/`SENIOR_PLAN`/`SENIOR_WALKTHROUGH` still winning over it), plus case-insensitivity and the existing cross-task load-spread invariant. It correctly identifies that the existing `afterEach` in `test/unit/tc_senior.test.ts` (currently saving/restoring only `SENIOR_DEFAULT`/`SENIOR_PLAN`/`SENIOR_WALKTHROUGH`) needs `SENIOR_SCALE_DEFAULT` added so new tests don't leak env state into others in the same `describe` block.
Verification steps (`npm run build`, targeted vitest run, full suite, mutation-based red/green checks) are appropriate and proportionate for a change this size. No scope creep, no untouched-behavior risk identified. Ready to proceed.
===== APPROVED PLAN =====
9:04 PM
Worked for 3m
Implementation Plan: Scale-Aware Senior Assignment (SENIOR_SCALE_DEFAULT)
1. Branch & Worktree Discipline
Work directly on the branch already checked out in the worktree (bureau-wt-5d29e47b-b423-4223-bfd5-69dfbbf913cb).
Do not create, switch, checkout, or rename branches.
2. Enumerable Scope (Components & Files to Change)
Component: Senior Harness
File:
engine/harness/senior.ts
assignSenior(opts: { kind: 'plan' | 'walkthrough' }): string:
Update precedence ladder:
SENIOR_PLAN / SENIOR_WALKTHROUGH (per-kind) or SENIOR_DEFAULT (global).
SENIOR_SCALE_DEFAULT (scale default if set).
Hardcoded defaults (plan -> 'claude', walkthrough -> 'zai').
Resolve and validate through resolveSenior(id).id.
assignSeniorForTask(taskId: string): string:
Update override ladder:
SENIOR_DEFAULT (global explicit override).
SENIOR_SCALE_DEFAULT (scale default if set).
Existing deterministic hash of taskId modulo registered seniors.
Resolve and validate through resolveSenior(override.toLowerCase()).id when set.
Component: Unit Tests
File:
test/unit/tc_senior.test.ts
Manage SENIOR_SCALE_DEFAULT in the test suite afterEach hook.
Add unit tests verifying each rung of the precedence hierarchy for assignSenior and assignSeniorForTask.
3. Tests to Add & Mutation Evidence Plan
Unit Tests in
test/unit/tc_senior.test.ts
Precedence Rung 1 (Explicit Overrides Win):
SENIOR_PLAN / SENIOR_WALKTHROUGH override SENIOR_SCALE_DEFAULT.
SENIOR_DEFAULT overrides SENIOR_SCALE_DEFAULT for both assignSenior and assignSeniorForTask.
Precedence Rung 2 (SENIOR_SCALE_DEFAULT Active):
With SENIOR_SCALE_DEFAULT=claude (and no other env var set), assignSenior({ kind: 'plan' }), assignSenior({ kind: 'walkthrough' }), and assignSeniorForTask(id) all return 'claude'.
Case insensitivity (e.g. 'CLAUDE' or 'zai') is validated.
Precedence Rung 3 (Default Baseline / Nothing Set):
With no senior environment variables set, behavior remains unchanged (plan -> 'claude', walkthrough -> 'zai', and assignSeniorForTask spreads tasks deterministically across seniors).
Mutation Evidence (Red/Green Proofs)
Mutation 1: Omit SENIOR_SCALE_DEFAULT in assignSenior -> Scale default walkthrough test fails (returns 'zai' instead of 'claude').
Mutation 2: Omit SENIOR_SCALE_DEFAULT in assignSeniorForTask -> Scale default task assignment test fails (returns hash senior instead of 'claude').
Mutation 3: Invert precedence so SENIOR_SCALE_DEFAULT overrides SENIOR_DEFAULT or SENIOR_PLAN -> Override test fails.
4. Walkthrough & Verification Plan
Build Verification: Run npm run build (tsc --noEmit) to ensure clean compilation.
Targeted Tests: Run npx vitest run test/unit/tc_senior.test.ts to verify all senior assignment tests pass.
Full Suite: Run npm test (vitest run) across the full test suite (579+ tests) to guarantee 0 regressions.
Mutation Execution: Apply each mutation in sequence, verify the expected test failure, revert, and record the mutation evidence.
Implementation Plan
Implementation plan for Scale-Aware Senior Assignment (SENIOR_SCALE_DEFAULT) to default reviews to the parallelizable Claude senior under opt-in concurrency while preserving existing explicit overrides and deterministic fallback behavior.
Proceed
9:04 PM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Implementation Plan: Scale-Aware Senior Assignment (SENIORSCALEDEFAULT) Branch & Worktree Discipline Work directly on the branch already checked out in the worktree (bureau-wt-5d29e47b-b423-4223-bfd5-69dfbbf913cb). Do not create, switch, checkout, or rename branches. Enumerable Scope (Components & Files to Change) Component: Senior Harness File: engine/harness/senior.ts assignSenior(opts: { kind: 'plan' | 'walkthrough' }): string: Update precedence ladder: SENIORPLAN / SENIORWALKTHROUGH (per-kind) or SENIOR_DEFAULT (global). SENIORSCALEDEFAULT (scale default if set). Hardcoded defaults (plan -> 'claude', walkthrough -> 'zai'). Resolve and validate through resolveSenior(id).id. assignSeniorForTask(taskId: string): string: Update override ladder: SENIOR_DEFAULT (global explicit override). SENIORSCALEDEFAULT (scale default if set). Existing deterministic hash of taskId modulo registered seniors. Resolve and validate through resolveSenior(override.toLowerCase()).id when set. Component: Unit Tests File: test/unit/tc_senior.test.ts Manage SENIORSCALEDEFAULT in the test suite afterEach hook. Add unit tests verifying each rung of the precedence hierarchy for assignSenior and assignSeniorForTask. Tests to Add & Mutation Evidence Plan Unit Tests in test/unit/tc_senior.test.ts Precedence Rung 1 (Explicit Overrides Win): SENIORPLAN / SENIORWALKTHROUGH override SENIORSCALEDEFAULT. SENIORDEFAULT overrides SENIORSCALE_DEFAULT for both assignSenior and assignSeniorForTask. Precedence Rung 2 (SENIORSCALEDEFAULT Active): With SENIORSCALEDEFAULT=claude (and no other env var set), assignSenior({ kind: 'plan' }), assignSenior({ kind: 'walkthrough' }), and assignSeniorForTask(id) all return 'claude'. Case insensitivity (e.g. 'CLAUDE' or 'zai') is validated. Precedence Rung 3 (Default Baseline / Nothing Set): With no senior environment variables set, behavior remains unchanged (plan -> 'claude', walkthrough -> 'zai', and assignSeniorForTask spreads tasks deterministically across seniors). Mutation Evidence (Red/Green Proofs) Mutation 1: Omit SENIORSCALEDEFAULT in assignSenior -> Scale default walkthrough test fails (returns 'zai' instead of 'claude'). Mutation 2: Omit SENIORSCALEDEFAULT in assignSeniorForTask -> Scale default task assignment test fails (returns hash senior instead of 'claude'). Mutation 3: Invert precedence so SENIORSCALEDEFAULT overrides SENIORDEFAULT or SENIORPLAN -> Override test fails. Walkthrough & Verification Plan Build Verification: Run npm run build (tsc --noEmit) to ensure clean compilation. Targeted Tests: Run npx vitest run test/unit/tc_senior.test.ts to verify all senior assignment tests pass. Full Suite: Run npm test (vitest run) across the full test suite (579+ tests) to guarantee 0 regressions. Mutation Execution: Apply each mutation in sequence, verify the expected test failure, revert, and record the mutation evidence.
9:09 PM
Worked for 3m
Walkthrough: Scale-Aware Senior Assignment (SENIOR_SCALE_DEFAULT)
The approved plan for scale-aware senior assignment has been implemented directly on the checked-out worktree branch (bureau-wt-5d29e47b-b423-4223-bfd5-69dfbbf913cb).
What Changed
engine/harness/senior.ts
:
Updated
assignSenior
precedence ladder:
Per-kind override (SENIOR_PLAN / SENIOR_WALKTHROUGH) or global override (SENIOR_DEFAULT).
Scale concurrency default (SENIOR_SCALE_DEFAULT).
Hardcoded defaults (plan → 'claude', walkthrough → 'zai').
Updated
assignSeniorForTask
ladder:
Explicit global override (SENIOR_DEFAULT).
Scale concurrency default (SENIOR_SCALE_DEFAULT).
Deterministic hash of taskId across registered seniors.
test/unit/tc_senior.test.ts
:
Added SENIOR_SCALE_DEFAULT to afterEach environment cleanup.
Added unit tests for each rung of the precedence ladder covering explicit overrides, SENIOR_SCALE_DEFAULT alone, unchanged baseline behavior with nothing set, and case-insensitivity.
Verification & Test Results
Build: npm run build (tsc --noEmit) clean with 0 errors.
Targeted Unit Tests: npx vitest run test/unit/tc_senior.test.ts passed (30/30 tests).
Full Suite: npx vitest run passed (582/582 tests across 109 test files).
Mutation Testing:
Mutation 1 (Omit scaleDefault in assignSenior): caught by walkthrough scale default test (expected 'zai' to be 'claude').
Mutation 2 (Omit scaleDefault in assignSeniorForTask): caught by task assignment scale default test (expected 'zai' to be 'claude').
Mutation 3 (Invert precedence so scaleDefault overrides SENIOR_DEFAULT/SENIOR_PLAN): caught by explicit override tests (expected 'claude' to be 'zai').
See
walkthrough.md
for detailed artifact documentation.
Walkthrough
Walkthrough for Scale-Aware Senior Assignment (SENIOR_SCALE_DEFAULT) covering implementation, unit tests, mutation testing, and full verification.
2 files changed
+66
-9
Review
9:09 PM
2 Files With Changes
Reject all
Accept all
+9
-5
senior.ts
d:\Dept of code v2\.bureau-worktrees\5d29e47b-b423-4223-bfd5-69dfbbf913cb\engine\harness\senior.ts
+57
-4
tc_senior.test.ts
d:\Dept of code v2\.bureau-worktrees\5d29e47b-b423-4223-bfd5-69dfbbf913cb\test\unit\tc_senior.test.ts
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Walkthrough: Scale-Aware Senior Assignment (SENIORSCALEDEFAULT) The approved plan for scale-aware senior assignment has been implemented directly on the checked-out worktree branch (bureau-wt-5d29e47b-b423-4223-bfd5-69dfbbf913cb). What Changed engine/harness/senior.ts: Updated assignSenior precedence ladder: Per-kind override (SENIORPLAN / SENIORWALKTHROUGH) or global override (SENIOR_DEFAULT). Scale concurrency default (SENIORSCALEDEFAULT). Hardcoded defaults (plan → 'claude', walkthrough → 'zai'). Updated assignSeniorForTask ladder: Explicit global override (SENIOR_DEFAULT). Scale concurrency default (SENIORSCALEDEFAULT). Deterministic hash of taskId across registered seniors. test/unit/tc_senior.test.ts: Added SENIORSCALEDEFAULT to afterEach environment cleanup. Added unit tests for each rung of the precedence ladder covering explicit overrides, SENIORSCALEDEFAULT alone, unchanged baseline behavior with nothing set, and case-insensitivity. Verification & Test Results Build: npm run build (tsc --noEmit) clean with 0 errors. Targeted Unit Tests: npx vitest run test/unit/tc_senior.test.ts passed (30/30 tests). Full Suite: npx vitest run passed (582/582 tests across 109 test files). Mutation Testing: Mutation 1 (Omit scaleDefault in assignSenior): caught by walkthrough scale default test (expected 'zai' to be 'claude'). Mutation 2 (Omit scaleDefault in assignSeniorForTask): caught by task assignment scale default test (expected 'zai' to be 'claude'). Mutation 3 (Invert precedence so scaleDefault overrides SENIORDEFAULT/SENIORPLAN): caught by explicit override tests (expected 'claude' to be 'zai'). See walkthrough.md for detailed artifact documentation.
