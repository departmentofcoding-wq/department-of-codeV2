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
