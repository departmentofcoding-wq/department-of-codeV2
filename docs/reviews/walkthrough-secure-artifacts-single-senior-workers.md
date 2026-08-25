# Walkthrough — secure artifacts + one-senior-per-task + live worker status

**Branch:** `wt/secure-artifacts-single-senior-workers` (base `main` @ `b036ff1`)
**Commit under review:** `7aba10f`
**Left UNMERGED** per the out-of-band-merge rule now on `main` — for operator review/merge, not a hand-merge.

## Why (three operator asks, 2026-08-25)

1. **Don't gitignore junior artifacts — keep + commit them for history, but be more secure.**
2. **Make sure only one senior reviews a given piece of work (no two seniors on the same code).**
3. **The Workers tab must accurately show a senior (or any employee) as active whenever it is running.**

All three keep the invariants: the done-gate (verifier exit 0 + human approval) is untouched.

## What changed — commit `7aba10f`

### 1. Secure artifacts (`engine/harness/junior-artifacts.ts`)
`writeJuniorArtifacts` now runs every artifact (`plan.md`, `walkthrough.md`, `reply.md`, `transcript.md`) through `redactOutput` **before writing to disk**. These files are kept and committed for history, so an API key or `KEY=value` line echoed in a junior transcript would otherwise live in git history forever. Same redaction door the console read APIs use (env-var secrets + `AIza…`/`sk-ant-…`/`sk-…`/`KEY=value` patterns → `[REDACTED]`).

### 2. One senior per task (`engine/harness/senior.ts`, `engine/flow/*`)
New `assignSeniorForTask(taskId)`: deterministic by task id, so the **same** senior reviews a task's plan **and** its walkthrough — the per-kind split (plan→claude, walkthrough→zai) had pulled **both** seniors onto one task. Load still spreads **across** tasks (hash of id), so both seniors stay busy. Threaded into `plan_review_cycle` and `work_review_cycle` (replacing `assignSenior({kind})`). `SENIOR_DEFAULT` still pins all tasks to one senior; `assignSenior({kind})` stays for the CLI/manual path. Pairs with the already-merged per-round conversation reuse (same senior + same conversation across a task's rounds).

### 3. Live worker status (`engine/dashboards/views.ts`, console)
`workerRoster` now counts **running `bureau_jobs`** mapped to roles via `JOB_KIND_ROLES` (`plan.cycle`→junior+senior, `work.cycle`/`senior.review-*`→senior, `junior.dispatch`→junior, `intake.turn`→officer, `verify.run`→verifier). A worker is active for the **whole duration** its job runs — a long senior review no longer shows Idle just because it only journals when it finishes. A role with a running job also appears on the roster even before it has journaled. `running_jobs` is surfaced through `WorkerDTO` and the console "Doing" column.

## Claims to verify (please re-run)

1. **Suite twice + build.** `npx vitest run` → **389/389** across 88 files; `npm run build` clean. (Baseline before this branch: 384/384 on merged main; +5 net.)
2. **Artifact scrub.** `test/unit/tc_senior.test.ts` → "writeJuniorArtifacts SCRUBS secrets before persisting": a plan/walkthrough/transcript carrying `AIzaSy…`, `GOOGLE_API_KEY=…`, `sk-ant-…` come back `[REDACTED]` from `readLatestArtifacts`.
3. **One senior per task.** `tc_senior.test.ts` → `assignSeniorForTask` is stable per task id (plan+walkthrough get the same senior), spreads across many tasks (both seniors used), and `SENIOR_DEFAULT` pins all tasks. The cycles use it (diff of `plan_review_cycle.ts` / `work_review_cycle.ts`).
4. **Active-while-running.** `tc_workers.test.ts` → "shows a worker active while its job is RUNNING": with a running `work.cycle` job and NO recent span (evaluated far in the future), `senior-engineer` is active with `running_jobs = 1`. The existing "idle when stale" test still passes (no running job there).

## Mutation suggestions for the Senior
- Remove the `redactOutput(...)` wrap in `writeJuniorArtifacts` → the secret-scrub test fails.
- Change `assignSeniorForTask` to key off a constant instead of the task id → the cross-task-spread test fails (only one senior ever used).
- Drop `runningJobs > 0` from the `active` predicate in `workerRoster` → the active-while-running test fails.

## Scope notes
- Does not implement the workspace/worktree reconciliation stream (still the path to automatic `done` + tracked delivery). This branch is the single-senior + observability + artifact-hygiene slice of `docs/plan-single-senior-per-task.md`, plus the artifact security ask.
- Per the rule on `main`, this branch is **left for the operator** — no hand-merge.
