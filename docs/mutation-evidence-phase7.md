# Mutation Evidence — Phase 7 (flow integration stream)

Stream: **Flow integration** (`wt/junior-a-flow-integration`) — integrating the
live harnesses (Antigravity juniors, Claude/ZCode seniors, adaptive wait) into
the jobs machinery: guards, ceilings, continuation, and verdict integrity.

Every mutation below was REALLY executed: the code was mutated, the named test
was run and observed to FAIL, the code was restored, and the test re-run green.
The reviewing Senior is expected to re-run representatives independently.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-F1 | `plan_rounds` ceiling entry-guard in `runPlanReviewCycle` | Guard condition replaced with `if (false && task.plan_rounds >= ceiling)` — an over-ceiling task proceeds to the junior | `tc_plan_cycle.test.ts` — "CEILING entry-guard: … REFUSES — guardrail span, task blocked, no junior invoked" | 1 failed / 8 passed |
| M-F2 | Fail-closed verdict parsing (`parseVerdict`) | Reintroduced the old approve-by-heuristic fallback line (`/\b(approve[d]?\|lgtm\|looks good\|ship it)\b/` → approve) | `tc_senior.test.ts` — "NEVER approves without an explicit VERDICT marker — approval-sounding prose still revises" | 1 failed / 13 passed |
| M-F3 | Stall/abort must not become a verdict (`ensureCompleted`) | Inserted `if (true) return;` so every non-completed wait is silently accepted | `tc_agent_wait.test.ts` — "throws on stalled / timeout / aborted, naming the agent and the reason" | 1 failed / 6 passed |
| M-F4 | Approve → pipeline continuation (dispatch enqueue) | `return enqueueJob(...)` guarded with `if (false)` — an approved plan records its review but never dispatches | `tc_plan_cycle.test.ts` — "APPROVE: records plan + review rows, and CONTINUES the pipeline — dispatch row + junior.dispatch job with the approved plan" | 1 failed / 8 passed |

Restoration verified after each mutation: the affected file's suite re-ran
green (full suite 281/281 twice on the branch tip, build clean — see the
walkthrough in `docs/reviews/walkthrough-flow-integration.md`).

---

## Stream A addendum — Multi-key Google provider (`wt/junior-a-google-provider`)

Multi-key Google Gemini provider with rate-limit steering, replacing the
un-provisioned Ollama officer backend. Every mutation below was really executed:
mutated, the named test observed FAILING, restored, re-run green.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-G1 | Key hygiene — llm/guardrail spans carry the `gkey-N` slot label, never the key (`call_model.ts` serving attribution) | `servingAccount` set to `attempt.key` (the raw key) instead of `googleKeyAccount(keyIndex)` | `tc_google_provider.test.ts` — "never writes key material to the journal — only the gkey-N slot label" | 3 failed / 6 passed |
| M-G2 | Proactive RPD steering — a key slot at its daily cap is skipped (`eligibleGoogleKeyPairs`) | Dropped the `u.rpd >= limit.rpd` term from the eligibility filter | `tc_google_provider.test.ts` — "proactively skips a key slot at its daily cap (RPD steering)" | 1 failed / 8 passed |
| M-G3 | Human verify-confirm gate on filing (carried from intake stream) | see `docs/mutation-evidence-console.md` M-INTAKE-1/2 | — | — |

Settings key-entry hygiene (`POST /api/settings/google-keys`) is covered by
`tc5_settings_keys_api.test.ts`: keys never appear in `bureau_journal`,
`bureau_meta`, `bureau_models`, or `bureau_assignments`; the update span records
`{ count }` only. Restoration verified: full suite 300/300, build clean.

## Stream addendum — Auto-kickoff flow (`wt/junior-auto-kickoff-flow`, `592dc09`)

The junior's walkthrough named the guard tests but shipped no mutation
evidence; the Senior executed the representatives independently and recorded
them here (verdict: `docs/reviews/verdict-auto-kickoff.md`).

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-AK1 | Deterministic plan-cycle job id — one task → one cycle (`engine/jobs/ids.ts`) | `planCycleJobId` time-suffixed (`plan.cycle:<id>:<Date.now()>`) | `file_task.test.ts` "auto-kickoff… keyed on the task id" + `reconcile.test.ts` "enqueues exactly one" | 4 failed (both DB impls each) |
| M-AK2 | claimJob kind exclusion — background runner never claims the console's inline-drained `intake.turn` (`engine/jobs/jobs.ts`) | `kindFilter` forced empty (and its params removed) | `jobs.test.ts` "claimJob skips excluded kinds so an inline-drained kind is left for its owner" | 2 failed (both DB impls) |
| M-AK3 | Reconciler `NOT EXISTS` counts failed cycles (`engine/flow/reconcile.ts`) — **not caught, by design** | subquery gained `AND j.state != 'dead'` | none — the deterministic-id `INSERT OR IGNORE` redundantly blocks re-enqueue of a dead cycle, so the outcome holds with either mechanism removed | 8/8 pass; defense-in-depth, recorded as such |

Restoration verified after each mutation: affected files re-ran green
(18/18 file_task+reconcile, 20/20 jobs); working tree clean.

## Stream addendum — First-run fixes (`wt/junior-assets-tab`, operator-directed)

Fixes cut against the gaps the first real end-to-end run exposed (the
"Department Assets" task, `82b97764`): a dead backup job, an unhonest
implementation prompt, a `javascript:` URL vector in the new Assets tab, the
plan→work loop dead-ending after implementation, and the plan-review ceiling
raised 3 → 7. Two representative guards were mutated and re-run live; the
backup fix is a regression proof (the pre-fix `require` threw at call time).

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-HREF | URL-scheme guard on rendered links — only http(s) becomes an `href` (`console/public/render.js` `safeHref`) | removed the `!/^https?:\/\//i` scheme check (return the raw url) | `tCONSOLE_assets_render.test.ts` "2b. URL scheme guard… inert" + `tCONSOLE_b1_render.test.ts` "9. safeHref…" | 2 failed (`javascript:alert(1)` rendered as a live href); restored → 15/15 pass |
| M-LOOP | Implementation dispatch chains a work review so a senior reads the walkthrough (`engine/harness/dispatch-job.ts`) | disabled the `chainWorkReview` enqueue (`if (false && …)`) | `tc_dispatch_antigravity.test.ts` "chainWorkReview: … enqueues a work.cycle" | 1 failed (no `work.cycle` enqueued); the negative "NO chaining by default" test still passed; restored → 3/3 pass |
| M-BACKUP | Real backup provider resolves without `require` in ESM (`engine/contract/backup-seam.ts`) | (regression) the pre-fix `require('../durability/git_backup_provider.ts')` — `require` is undefined in an ES module, so every `backup.push` job died | `tc_backup_seam.test.ts` "resolves the real ExecGitBackupProvider without throwing" | pre-fix: throws "require is not defined"; post-fix (top-level import): provider instantiates, suite green |

Also covered by new/updated tests (not separately mutated here): the honest
implementation prompt on the ceiling path (`tc_plan_cycle.test.ts` "buildImplementationPrompt
is HONEST on the ceiling path"), the `queued→claimed` transition on plan
approval ("APPROVE from queued… no longer a zombie"), the work-review cycle
approve/revise/no-walkthrough paths (`tc_work_cycle.test.ts`), and the
task-grouped history log (`tCONSOLE_b1_render.test.ts` "11. … GROUPS entries by
task"). The plan-rounds ceiling raise (3 → 7) updated `contract_d0.test.ts` and
pinned the ceiling explicitly in the exhaustion tests (`t39_t40`, `tc_plan_cycle`).

Restoration verified after each mutation: affected files re-ran green; full
suite 338/338 across 81 files, `npm run build` clean, twice.

## Stream addendum — Bounded work-review loop (`wt/junior-assets-tab`, operator-directed)

The work review now CYCLES: on REVISE the senior's fixes are fed back to the
junior, which implements them and its new walkthrough is re-reviewed, looping
until APPROVE — bounded to 5 rounds (`review:work_rounds_ceiling`), at which the
task is blocked for the operator rather than looping the live agents forever.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-WLOOP | Work-review ceiling blocks the task instead of looping forever (`engine/flow/work_review_cycle.ts`) | disabled the ceiling check (`if (false && roundsUsed >= ceiling)`) so it re-dispatches at the ceiling | `tc_work_cycle.test.ts` "REVISE at the ceiling: stops looping — the task is BLOCKED" | 1 failed (task not blocked, runaway fix dispatch enqueued); restored → 6/6 pass |

The loop's revise-under-ceiling path (fix fed back to the same junior, chaining a
re-review) and the honest fix prompt are covered by `tc_work_cycle.test.ts`
("REVISE under ceiling…", "buildFixPrompt is honest…"). Restoration verified:
full suite 340/340 across 81 files, build clean.

## Stream addendum — Ntfy task status notifications (`wt/junior-ntfy-notifications`)

Integrate ntfy.sh push notifications for proactive alerts when tasks transition to
`blocked` or `done` states. Operator Console settings schema and UI support
`ntfy_server_url` and `ntfy_topic`, persisted in `bureau_meta`. Real test seam
guarantees zero network calls during verification.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-NTFY-1 | Notification body formatting — Task ID inclusion (`engine/notifications/ntfy.ts`) | Removed `Task ID: ${payload.taskId}` line from formatted notification payload | `tc_ntfy_client.test.ts` "formats endpoint URL and message body correctly for blocked tasks" | 2 failed / 2 passed (AssertionError: expected body to contain 'Task ID: task-1234'); restored → 4/4 pass |
| M-NTFY-2 | Blocked task status notification dispatch (`engine/state/machine.ts`) | Changed transition condition from `toState === 'blocked' \|\| toState === 'done'` to `toState === 'done'` (omits blocked alerts) | `tc_ntfy_task_notifications.test.ts` "triggers formatted ntfy notification when task transitions to blocked" | 2 failed / 2 passed (AssertionError: expected +0 to be 1); restored → 4/4 pass |
| M-NTFY-3 | Ntfy settings persistence in `bureau_meta` (`console/server.ts` `POST /api/settings/ntfy`) | Omitted `bureau_meta` update transaction inside the POST route handler | `tc_ntfy_settings_api.test.ts` "persists ntfy settings to bureau_meta and journals update" | 1 failed / 3 passed (AssertionError: expected undefined to be 'https://ntfy.mycorp.internal'); restored → 4/4 pass |

Restoration verified after each mutation: all affected unit and integration tests re-ran
green; full suite 353/353 across 84 files, `npm run build` clean twice.


## Stream addendum — Console task archive + Workers flow view (`wt/console-tasks-archive-flow`, Senior-executed)

The junior shipped no mutation evidence for this stream; the Senior executed
these three live (mutate → watch the real test fail → restore → re-run green),
matching the auto-kickoff precedent (M-AK1/2/3).

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-ARCH-1 | Archive is human-operator-gated (`engine/state/archive.ts`) | deleted the `actor_role !== 'human-operator'` refusal from `archiveTask` | `tc_task_archive.test.ts` "refuses a non-operator actor (fail-closed)" | 1 failed / 5 passed (a junior role archived a task); restored → 6/6 pass |
| M-ARCH-2 | Live task list excludes archived rows (`console/server.ts` `GET /api/tasks`) | dropped `WHERE archived_at IS NULL` from the live-list query | `tc7_archive_flow_api.test.ts` "1. archive removes a task from the live list…" | 1 failed / 5 passed (archived task still listed live); restored → 6/6 pass |
| M-SENR-1 | Senior review reuses the conversation on continuation rounds (`engine/flow/work_review_cycle.ts`) | hardcoded `freshConversation: true` (always a cold window, the pre-fix behavior) | `tc_work_cycle.test.ts` "continuation round reuses the senior conversation (freshConversation false when cycles > 0)" | 1 failed / 6 passed; restored → 7/7 pass |

The remaining guards are covered by direct tests, not mutation (verified by
inspection): the done-gate CHECK is asserted un-bypassable by
`tc_task_archive.test.ts` ("does NOT let archiving forge a done"), the
plan-cycle threading by `tc_plan_cycle.test.ts` (round-1 fresh / REVISE
continue), unarchive idempotence + unknown-task refusal by `tc_task_archive`,
and the fail-closed (no-token) behavior for all four new endpoints by
`tc7_archive_flow_api.test.ts` #5. Restoration verified after each mutation;
full suite 375/375 across 87 files, `npm run build` clean, twice.

## Stream addendum — Completed/Done tag for shipped tasks (`wt/task-completion-tag`, Senior-executed)

The junior flagged honestly that it shipped no mutation evidence for this
stream; the Senior executed these live (mutate → watch the real test fail →
restore → re-run green), per the M-ARCH/M-SENR precedent.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-COMP-1 | Completion is human-operator-gated (`engine/state/completion.ts`) | deleted the `actor_role !== 'human-operator'` refusal from `markTaskCompleted` | `tc_task_completion.test.ts` "refuses a non-operator actor (fail-closed)" | 1 failed / 4 passed (a junior role completed a task); restored → 5/5 pass |
| M-COMP-2 | Live task list excludes completed rows (`console/server.ts` `GET /api/tasks`) | dropped `AND completed_at IS NULL` from the live-list query | `tc7_archive_flow_api.test.ts` "7. complete tags a task (with commit) and moves it from live to the completed list" | 1 failed / 8 passed (completed task still listed live); restored → 9/9 pass |

Remaining guards covered by direct tests (verified by inspection): the
done-gate CHECK is asserted un-bypassable by `tc_task_completion.test.ts`
("does NOT let completion forge a done"), idempotence + reopen by the same
file, unknown-task refusal + no-token fail-closed by
`tc7_archive_flow_api.test.ts` #9, and the render escaping (XSS) by
`tCONSOLE_b1_render.test.ts` #3c2/#9/#10. Restoration verified after each
mutation; full suite 384/384 across 88 files, `npm run build` clean, twice.

## Stream addendum — Multi-repository project support (`wt/junior-multi-repo-projects`)

Introduces first-class `bureau_projects` table and maps tasks / intake sessions to specific repository directories, with base-branch normalization and dynamic per-task worktree / dispatch routing. Every mutation was really executed: mutated, the named test observed FAILING, restored, and re-run green.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-PROJ-1 | Project registration path existence gate (`engine/projects/manager.ts`) | Removed `fs.existsSync(resolvedPath)` check before directory stat | `tc_projects.test.ts` "refuses registration if target path does not exist on disk" | 1 failed / 7 passed (`AssertionError: expected [Function] to throw error matching /Target path does not exist on disk/`); restored → 8/8 pass |
| M-PROJ-2 | Task filing project propagation (`engine/filing/file_task.ts`) | Hardcoded `null` for `project_id` in `bureau_tasks` INSERT statement | `tc_intake_project.test.ts` "fileTask propagates session.project_id to bureau_tasks.project_id" | 2 failed / 4 passed (`AssertionError: expected null to be '...'`); restored → 6/6 pass |
| M-PROJ-3 | Multi-repo worktree root routing & base ref normalization (`engine/worktrees/manager.ts`) | Hardcoded `'main'` in `git worktree add` without calling `resolveBaseRef` | `tc_multi_repo_execution.test.ts` "prepares worktree in secondary master-defaulted project repository without failing on main branch check" | 1 failed / 2 passed (`fatal: invalid reference: main`); restored → 3/3 pass |

Restoration verified after each mutation: all project test files re-ran green (17/17 tests across 3 files); full suite 401/401 across 91 files, `npm run build` clean twice.

