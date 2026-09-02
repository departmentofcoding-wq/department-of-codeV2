walkthrough.md
for full details.
Walkthrough
Walkthrough for Phase 8 Entry Fix Pack (F1-F6) closing delivery-tail drill scars. Details code changes across runner, flow, delivery, harness, scripts, and docs, test results (105 test files, 516 tests passing twice), and mutation evidence for M-TAIL-1 and M-TAIL-2.
16 files changed
+539
-55
Review
16 Files With Changes
Reject all
Accept all
+6
-0
main.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\runner\main.ts
+8
-6
commit.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\worktrees\commit.ts
+25
-8
work_review_cycle.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\flow\work_review_cycle.ts
+3
-2
plan_review_cycle.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\flow\plan_review_cycle.ts
+2
-2
plan_review_job.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\review\plan_review_job.ts
+1
-1
types.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\contract\types.ts
+2
-2
gh_cli_pr_provider.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\delivery\gh_cli_pr_provider.ts
+1
-1
fake_pr_provider.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\test\helpers\fake_pr_provider.ts
+7
-1
pr_create.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\delivery\pr_create.ts
+2
-2
t43_pr_create.test.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\test\integration\t43_pr_create.test.ts
+1
-1
senior.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\engine\harness\senior.ts
+19
-5
intake.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\scripts\intake.ts
+7
-0
antigravity-integration.md
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\docs\antigravity-integration.md
+388
-0
tc_tail_fixes.test.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\test\unit\tc_tail_fixes.test.ts
+43
-0
mutation-evidence-phase8.md
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\docs\mutation-evidence-phase8.md
+1
-1
tc_plan_cycle.test.ts
d:\Dept of code v2\.bureau-worktrees\e156395d-369f-494c-8237-ea1be5ee1aa8\test\integration\tc_plan_cycle.test.ts
