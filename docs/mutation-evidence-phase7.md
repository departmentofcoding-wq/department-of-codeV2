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
