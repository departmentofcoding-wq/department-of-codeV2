Walkthrough & Verification Summary
What Changed
backup_push.ts
:
Removed the inline SQL lookup (SELECT project_id FROM bureau_tasks / SELECT path_to_repo FROM bureau_projects).
Replaced it with the shared
getTaskRepoRoot
helper from engine/worktrees/manager.ts.
Fallback cleanly defaults to path.resolve(import.meta.dirname, '../..') (the dept engine source root) for dept tasks (project_id: null) or when task_id is omitted.
tc_backup_project_repo.test.ts
:
Added test case for dept tasks (project_id: null) confirming fallback to default engine root.
Added test case for missing/omitted task_id confirming fallback to default engine root.
Added test case for concrete cwd threading asserting provider.repoRoot matches the helper resolution.
t48_backup_push.test.ts
:
Added test case verifying project-associated tasks execute backup pushes through getTaskRepoRoot.
Verification & Test Results
Targeted Unit & Integration Tests:
test/unit/tc_backup_project_repo.test.ts (5/5 passed)
test/unit/t48_backup_push.test.ts (3/3 passed)
test/unit/tc_backup_truth.test.ts (4/4 passed)
test/integration/t46_sandbox_remote.test.ts (2/2 passed)
Mutation Testing:
Mutation 1 (Bypassing getTaskRepoRoot / hardcoded path): Mutated backup_push.ts to pass /dummy/wrong/path; tc_backup_project_repo.test.ts failed on 4 tests verifying the path check is load-bearing.
Mutation 2 (Broken dept fallback): Mutated defaultRoot fallback to /broken/dept/fallback; tc_backup_project_repo.test.ts failed on the 2 fallback tests.
Both mutations reverted cleanly and verified green.
Full Test Suite (npm test):
All 128 test files passed (720 tests green).
Walkthrough
Walkthrough summarizing N9 tidy refactor in backup_push.ts: reusing getTaskRepoRoot for repo resolution, test coverage extensions, and mutation/regression verification.
3 files changed
+183
-19
Review
