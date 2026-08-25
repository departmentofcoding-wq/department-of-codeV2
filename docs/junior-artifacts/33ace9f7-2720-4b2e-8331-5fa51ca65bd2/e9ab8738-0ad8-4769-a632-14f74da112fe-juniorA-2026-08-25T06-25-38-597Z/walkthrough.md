Summary of Changes
Contracts & Database Schema
engine/contract/constants.ts
: Registered 'project-registered' in SPAN_KINDS.
engine/contract/types.ts
: Added BureauProjectRow, RegisterProjectInput, and project_id: string | null to BureauTaskRow and BureauIntakeSessionRow.
engine/db/schema.ts
: Added bureau_projects table DDL, project_id foreign key columns in bureau_tasks and bureau_intake_sessions, boot migration list updates in ADDED_COLUMNS, and table rebuild logic preserving project_id.
Project Management & Worktree Routing
engine/projects/manager.ts
&
engine/projects/index.ts
: Project subsystem for registering, listing, and resolving projects with disk directory validation, .git existence checks, .gitignore auto-updates (/.bureau-worktrees/), and journal span emission.
engine/worktrees/manager.ts
: Added getTaskRepoRoot and dynamic base ref resolution resolveBaseRef (main $\rightarrow$ master $\rightarrow$ origin/HEAD $\rightarrow$ HEAD), ensuring worktrees are prepared in the associated project directory without failing on non-main branches.
Intake, Filing & Review Flows
engine/intake/session.ts
: Added projectId support to createSession and updateSessionDraft.
engine/filing/file_task.ts
: Propagated session.project_id to bureau_tasks.project_id.
engine/officers/task_intake_officer.ts
: Registered projects list injected into Task Intake Officer prompt context.
engine/flow/plan_review_cycle.ts
&
engine/flow/work_review_cycle.ts
: Resolved target project folder for junior commands (runCommand({ folder })), injected PROJECT: <name> (<path>) header into planning/fix prompts, and passed project context to senior review driver.
engine/harness/senior.ts
: Added projectName and projectPath to SeniorReviewInput and review prompt builder.
CLI Tools
scripts/project.ts
: Added CLI utility supporting register, list, and show.
scripts/intake.ts
: Added --project <idOrName> option and display of registered project details.
package.json
: Added "project" npm script.
Verification & Mutation Evidence
New Test Files Added:
test/unit/tc_projects.test.ts (8 unit tests — all passed)
test/unit/tc_intake_project.test.ts (6 unit tests — all passed)
test/integration/tc_multi_repo_execution.test.ts (3 integration tests — all passed)
Mutation Evidence:
M-PROJ-1 (Path Existence Gate): Caught by tc_projects.test.ts.
M-PROJ-2 (Task Filing Project Propagation): Caught by tc_intake_project.test.ts.
M-PROJ-3 (Multi-Repo Base Ref Normalization): Caught by tc_multi_repo_execution.test.ts.
Recorded in
docs/mutation-evidence-phase7.md
.
Full Test Suite (Executed Twice):
Pass 1: 406/406 passed across 91 test files.
Pass 2: 406/406 passed across 91 test files.
Typecheck:
npm run build (tsc --noEmit) exited with code 0.
Detailed documentation is available in
walkthrough.md
.
Walkthrough
Walkthrough artifact documenting the multi-repository project support implementation, test results, mutation evidence, and verification.
19 files changed
+1004
-38
Review
19 Files With Changes
Reject all
Accept all
+1
-0
constants.ts
d:\Dept of code v2\engine\contract\constants.ts
+18
-0
types.ts
d:\Dept of code v2\engine\contract\types.ts
+16
-2
schema.ts
d:\Dept of code v2\engine\db\schema.ts
+141
-0
manager.ts
d:\Dept of code v2\engine\projects\manager.ts
+2
-0
index.ts
d:\Dept of code v2\engine\projects\index.ts
+41
-14
manager.ts
d:\Dept of code v2\engine\worktrees\manager.ts
+11
-3
session.ts
d:\Dept of code v2\engine\intake\session.ts
+3
-2
file_task.ts
d:\Dept of code v2\engine\filing\file_task.ts
+18
-3
task_intake_officer.ts
d:\Dept of code v2\engine\officers\task_intake_officer.ts
+4
-0
senior.ts
d:\Dept of code v2\engine\harness\senior.ts
+29
-7
plan_review_cycle.ts
d:\Dept of code v2\engine\flow\plan_review_cycle.ts
+19
-3
work_review_cycle.ts
d:\Dept of code v2\engine\flow\work_review_cycle.ts
+38
-1
intake.ts
d:\Dept of code v2\scripts\intake.ts
+106
-0
project.ts
d:\Dept of code v2\scripts\project.ts
+2
-1
package.json
d:\Dept of code v2\package.json
+179
-0
tc_projects.test.ts
d:\Dept of code v2\test\unit\tc_projects.test.ts
+181
-0
tc_intake_project.test.ts
d:\Dept of code v2\test\unit\tc_intake_project.test.ts
+176
-0
tc_multi_repo_execution.test.ts
d:\Dept of code v2\test\integration\tc_multi_repo_execution.test.ts
+13
-0
mutation-evidence-phase7.md
d:\Dept of code v2\docs\mutation-evidence-phase7.md
