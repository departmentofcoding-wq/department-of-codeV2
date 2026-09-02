File
Edit
Selection
View
Go
Run
Terminal
Help
6490336d-9aec-44d6-9d23-b8e06bc062b5 - Antigravity IDE
Explorer
6490336d-9aec-44d6-9d23-b8e06bc062b5
console
docs
engine
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
wt/junior-a-project-provisioning
0
0
Antigravity - Settings
Implement Automated Project Provisioning
No more older messages
Your plan went through 7 review round(s) and the review-round ceiling (7) was reached with the senior's feedback still outstanding. Rather than stall the task, implement now on this plan — but you MUST address the final required changes below as you do.
Rules: work on the branch named in the plan; add the tests the plan names; when done, finish with a walkthrough section summarizing what changed, the test results, and the verification you ran.
===== TASK =====
TITLE: Implement self-serve project provisioning with job-driven workflow
INTENT: The department requires a secure, automated way for engineers to provision new projects. This system handles folder creation, Git initialization, GitHub repository creation via CLI, and registration in the bureau project database. It utilizes the job system for retriability and auditability.
SPEC: 1. Database: Update `bureau_projects` table (schema.ts) with `github_url`, `provisioned_by`, and `visibility`. Add new constants for span/job kinds.
2. Config: Introduce `projects_root`, `repo_prefix`, and `github_owner` in `bureau_meta`.
3. Provisioning Logic: Implement `provisionProject` in `engine/projects/provision.ts`. Features include slug validation, case-insensitive collision checks, actor allowlisting, path containment enforcement, local Git initialization, and remote creation via `GhCliRepoProvider`.
4. Job System: Define `project.provision` job kind with a deterministic ID pattern (`project.provision:canonical`).
5. CLI: Extend `scripts/project.ts` to include a `create` command that enqueues the job and drains it.
6. Testing: Use temporary directories and a fake `RepoProvider` to avoid network dependencies. Cover all edge cases: slug validation, directory traversal, actor restrictions, and error recovery. Ensure no secrets are logged or persisted.
ACCEPTANCE: 1. All provisioning logic (folder, Git, GitHub repo, DB registration) succeeds for authorized roles.
2. Proper guardrails (allowlist, path-containment, naming) reject invalid requests with appropriate spans.
3. Job-based retries handle remote failures; no partial/orphaned DB rows on failure.
4. Deterministic job IDs prevent duplicate enqueues.
5. Unit tests pass: T-records verify slug handling, prefixing, actor rules, folder containment, and retriability.
6. Security check: Zero secrets in DB/journal.
7. Mutation testing: M-PROV-1 to M-PROV-4 induce failures when removed.
===== SENIOR'S FINAL REQUIRED CHANGES =====
Deterministic rubric failure: missing walkthrough / verification plan
===== PLAN (implement, addressing the changes above) =====
8:20 PM
Worked for 2m
I have prepared the implementation plan for Self-Serve Project Provisioning (Job-Driven Workflow) according to the specification and department laws.
Please review the plan in
implementation_plan.md
.
Summary of Key Plan Elements
Branch: wt/junior-a-project-provisioning
Scope:
Contract constants (SPAN_KINDS, JOB_KINDS, PROJECT_META_KEYS) and types in engine/contract/
Database schema updates in engine/db/schema.ts (bureau_projects table DDL + ADDED_COLUMNS)
RepoProvider seam & GhCliRepoProvider in engine/projects/repo_provider.ts
bureau_meta config helpers in engine/projects/config.ts
Core provisionProject logic with full guardrails in engine/projects/provision.ts
Deterministic job derivation (projectProvisionJobId) in engine/jobs/ids.ts and handler in engine/jobs/registry.ts
CLI create subcommand in scripts/project.ts
Tests & Mutation Evidence:
T-Records T-PROV-1 to T-PROV-9 in test/unit/tc_project_provisioning.test.ts
Real mutation verifications M-PROV-1 to M-PROV-4
Verification:
Zero network dependencies (isolated fake RepoProvider in unit tests)
Secret scan across the SQLite database and journal
Full test suite run (vitest) and typecheck (tsc --noEmit)
Implementation Plan
Implementation plan for self-serve project provisioning with job-driven workflow, including schema updates, repo provider seam, provisioning logic, deterministic jobs, CLI support, comprehensive test coverage, and mutation testing plan.
Proceed
8:20 PM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
I have prepared the implementation plan for Self-Serve Project Provisioning (Job-Driven Workflow) according to the specification and department laws. Please review the plan in implementation_plan.md. Summary of Key Plan Elements Branch: wt/junior-a-project-provisioning Scope: Contract constants (SPANKINDS, JOBKINDS, PROJECTMETAKEYS) and types in engine/contract/ Database schema updates in engine/db/schema.ts (bureauprojects table DDL + ADDEDCOLUMNS) RepoProvider seam & GhCliRepoProvider in engine/projects/repo_provider.ts bureau_meta config helpers in engine/projects/config.ts Core provisionProject logic with full guardrails in engine/projects/provision.ts Deterministic job derivation (projectProvisionJobId) in engine/jobs/ids.ts and handler in engine/jobs/registry.ts CLI create subcommand in scripts/project.ts Tests & Mutation Evidence: T-Records T-PROV-1 to T-PROV-9 in test/unit/tcprojectprovisioning.test.ts Real mutation verifications M-PROV-1 to M-PROV-4 Verification: Zero network dependencies (isolated fake RepoProvider in unit tests) Secret scan across the SQLite database and journal Full test suite run (vitest) and typecheck (tsc --noEmit)
8:22 PM
Worked for 28s
Timed
5 seconds
I have checked out branch wt/junior-a-project-provisioning and am waiting for the baseline vitest run and build to finish.
Waiting for tests: Timer has expired
Worked for 7s
Timed
5 seconds
I am continuing to wait for the test suite and build check to finish.
Wait for vitest: Timer has expired
Worked for 6s
Timed
5 seconds
I am waiting for the baseline vitest and build check to complete.
Wait for vitest completion: Timer has expired
Worked for 10s
Timed
10 seconds
I am waiting for the baseline test suite run to finish.
8:22 PM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Working... I have checked out branch wt/junior-a-project-provisioning and am waiting for the baseline vitest run and build to finish.
