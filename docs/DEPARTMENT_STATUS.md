# Department of Code v2 — Department Status Ledger

**This file is the department's memory across sessions and windows.** Every new
session (Senior, Junior, or Operator) reads this file FIRST, then the current
phase plan, then git. Nothing important lives only in a chat window.

---

## Current status

| | |
|---|---|
| **Phase** | **Phase 7 — Live operation: IN PROGRESS. The department has now shipped TWO real tasks end-to-end. Task `82b97764` (assets tab, `c7f9b37`). Task `e489b734` (ntfy notifications, `1c14534`) went filed → auto-kickoff → plan review → ZAI approve → junior IMPLEMENTED + COMMITTED (`1bbee8d`) → ZAI walkthrough review → merge — and en route surfaced + fixed two live-harness bugs that had blocked completion (junior new-conversation readiness; senior completion-detection false-positive). The plan→work flow loop is CLOSED and now runs without hanging. (Phase 6 Operator Console: complete.)** |
| Main | D0-C (`59acc69`), Stream A (`fc97549`), Stream B (`8944670`), launcher integration fix (`eb39d36`). Prior: Phase 5 at `8974b0f`. All Senior-verified. Latest: console intake `baa5b74`; Stream A google-provider `a74131d`; auto-kickoff flow `64d33cd` (feature `592dc09`, Senior verdict `f8aceeb`); **assets-tab flow `c7f9b37`** (feature tip `05dd8fb`, Senior verdict `0a1100a`); **ntfy flow `1c14534`** (feature tip `f349a13`, Senior verdict `d398b53`); **console task archive + Workers flow view + senior conversation reuse `1710098`** (features `27b85e5` + `60be286`, Senior verdict `docs/reviews/verdict-console-archive-flow.md`). |
| Suite | 375/375 tests, 87 files, `npm run build` clean (on merged main, Senior re-run twice). **Two seniors drivable** (claude = Claude CLI subprocess; zai = ZCode/GLM CDP GUI @9335) — review-only, fail-closed verdicts, both verified live; single-reviewer assignment, model selection + quota for each; manual `docs/senior-integration.md`. Console has a **Workers tab** (`GET /api/workers` + `GET /api/flow` pipeline stepper, `workerRoster`/`taskFlow`) — department roster with live active/idle status plus per-task stage + stuck flag, verified against `db/bureau.db`. **Two juniors now drivable** (A = Antigravity IDE @9333, B = Antigravity 2.0 @9334) from code + via `junior.dispatch` (`junior`/`model`/`folder` payload fields); GUI model + folder selection, plan/walkthrough/full-output captured to `docs/junior-artifacts/`. Manual: `docs/antigravity-integration.md`. |
| In flight | Nothing. Clean handoff point. |
| Next action | **Phase 7 continues → `docs/phase-7-plan.md`.** Two real tasks shipped (`c7f9b37`, `1c14534`); the two live-harness bugs the ntfy run exposed are fixed (new-conversation readiness gate; completion-detection no longer reads "working" from agent prose). **Immediate next — the one remaining flow gap: workspace/worktree reconciliation.** The harness junior writes in its own IDE workspace, not a bureau worktree, so the auto-flow stops at the work review; wire `verify.run → needs-review` against the junior's actual branch so a task can reach `done` automatically (done-gate invariant — verifier exit 0 + human approval — stays absolute). Also still open from before: A2 `[llm]` provider-doubling, A3 budget-refusal proof, C1 delivery (PR/merge/backup) against a sandbox *remote*. After Phase 7: **Phase 8 — multi-task / concurrency at scale.** Gemini keys live (env + gitignored `secrets/google.env`); ceilings live in `bureau_meta` (`review:plan_rounds_ceiling`=7, `review:work_rounds_ceiling`=5). |

**Completed/Done tag + out-of-band-merge rule now LAW (2026-08-25, merged
`5724772`):** shipped-out-of-band work can be TAGGED completed (green ✓ Completed,
records the shipping commit) via a marker orthogonal to `state` — `completed_at/
completed_by/completion_commit/completion_note`, `markTaskCompleted`/`reopenTask`,
console Live/Completed/Archived views (`GET /api/tasks/completed`,
`POST /api/tasks/:id/{complete,reopen}`; ENDPOINTS 24→27) — never a forged `done`
(done-gate absolute). Live DB reconciled: the two shipped tasks are now completed
(`82b97764`→`c7f9b37`, `e489b734`→`1c14534`), the two test artifacts archived,
zero `done` rows. **New non-negotiable rule enacted (this merge is the sanctioned
final hand-merge that makes it law): no out-of-band merges/commits to `main`** —
every merge is a tracked act (bureau_jobs row + journal span + task state);
hand-merges PAUSED until workspace/worktree reconciliation lands. Root cause on
the record (0 worktrees/verify.run/pr.* jobs, 0 merge spans for the shipped
tasks): the harness junior works in its own IDE workspace, not a bureau worktree.
ZAI verdict `docs/reviews/verdict-task-completion-tag.md` (APPROVE, M-COMP-1/2).
Suite 384/384, build clean. Plan for single-senior-per-task efficiency filed:
`docs/plan-single-senior-per-task.md`.

**Console task archive + Workers flow view + senior conversation reuse
(2026-08-24, merged `1710098`):** the Tasks view carried test artifacts and
out-of-band shipments with no way to clear them, the Approve button could never
fire, and the pipeline had no visual. All closed on `wt/console-tasks-archive-flow`
(features `27b85e5` + `60be286`, Senior verdict
`docs/reviews/verdict-console-archive-flow.md`, Senior-executed mutations
M-ARCH-1/2 + M-SENR-1 in `docs/mutation-evidence-phase7.md`): (1) **Archive** —
`archived_at/archived_by/archive_reason` columns + `engine/state/archive.ts`
(operator-gated, journaled, idempotent, `WHERE archived_at IS NULL`-guarded) +
4 console endpoints (`GET /api/tasks` live-only, `GET /api/tasks/archived`,
`POST /api/tasks/:id/{archive,unarchive}`); **archiving never touches `state`,
so the done-gate CHECK stays absolute**; dashboards + flow exclude archived.
(2) **Approve-gate fix** — the button checked `state==='verifying'` but
`approveTask` requires `needs-review`; corrected to match the engine. (3)
**Workers flow view** — `GET /api/flow` (`taskFlow`) projects every in-flight
task onto Intake → Queued → In progress → Verify → Review → Done with owner,
budgets, and a stuck flag (blocked/failed or stalled >15m). (4) **Senior
conversation reuse** — `ZCodeSenior.review` now reuses one conversation across
a task's review rounds (`freshConversation` threaded by both cycles), mirroring
the junior side; reviews stay self-contained each round. (5) **Live-DB
reconciled** — backed up (`db/backups/bureau.pre-reconcile-20260824-231612.db`)
then the two "Add subtract()" test artifacts and the two shipped-out-of-band
tasks (assets `c7f9b37`, ntfy `1c14534`) archived with reasons; states
preserved, zero `done` rows forged, four `human` journal spans (250–253).
Suite 375/375 across 87 files on merged main, build clean. **Operator
advisories:** (a) an external process is auto-committing
`docs/junior-artifacts/` transcripts straight to `main` (`465fc64`, `bbe1830`)
— docs-only but it bypasses the verdict gate; identify/retire it. (b) A live
console (`scripts/console.ts`) runs a background Runner from this tree; its
dispatches keep writing `docs/junior-artifacts/` (one untracked transcript
dir present at merge time).

**ntfy notifications — second real task shipped, two harness bugs fixed
(2026-08-24, merged `1c14534`):** task `e489b734` (filed via the live Gemini intake
officer) ran the whole flow — plan authored → ZAI approved → junior **implemented
AND committed** ntfy (`1bbee8d`, 15 files +844/−11: `engine/notifications/ntfy.ts`
+ seam, trigger hooks in `state/notifications.ts`/`machine.ts`, Console Settings →
ntfy, 4 test files, M-NTFY-1…3) → ZAI walkthrough review → merge (Senior verdict
`docs/reviews/verdict-ntfy.md`). En route the run exposed and fixed two live-harness
bugs, each committed with a regression test: (1) **junior new-conversation** — the
harness drove the Antigravity Agent panel before it mounted and hard-failed;
`ensureChatInputReady()` (opens the panel, waits for the input) + `newConversation()`
now clicks the stable `data-tooltip-id="new-conversation-tooltip"` control
(`5235175`). (2) **senior completion-detection** — the waiter matched the word
"working" ANYWHERE in the page, so ZAI's own "…working tree clean…" made it wait to
the 45-min job timeout with no verdict captured (and wedged the runner); a shared,
unit-tested `AGENT_PROGRESS_LABEL_RE` now requires a standalone status label
(`d1a978c`). **Correction on the record:** an earlier read of this run wrongly
concluded the junior's changes "don't persist" — they DO (the junior branches +
commits); the real blocker was the completion-detection false-positive. Scars: the
`review:work_rounds_ceiling`=5 loop and the done-gate are untouched; the DB task row
for `e489b734` stays `claimed` (the work shipped via the Senior review+merge path,
not the worktree/verify path — same decoupling as the assets task, and the reason
the worktree/verify reconciliation is the next stream). Suite 355/355 across 84
files on merged main (operator re-run), build clean.

**Pipeline verification (live, 2026-08-18):** a real task was driven end-to-end
against the dept machinery on the sandbox repo, in an isolated temp DB —
**intake → worktree.prepare → junior.dispatch → verify.run → needs-review** — and
**every act journaled**. 12 attributed spans across 5 kinds recorded the whole
run: `system`/`transition` (foreman/deterministic), `dispatch` + `observation`
(junior-engineer/**antigravity** — the real agent answered "return a - b;" on
Gemini 3.7 Flash), `tool`+`transition` (verifier/deterministic, `verifier_exit_code=0`,
env scrubbed, one `bureau_verify_runs` row). The task advanced to `needs-review`
— the exact gate the Operator Console's approve action serves. Junior step kept
safe (agent *consulted*, not turned loose on an uncontrolled workspace); the
controlled edit was applied in the worktree. Finding: `GitWorkspaceProvider`
hardcodes the `main` base branch — a repo on `master` fails `worktree add`
(`fatal: invalid reference: main`); normalize the base ref or document the
`main` requirement.

**Antigravity junior integration (`9447e7e`):** the department can now drive its
junior (the Antigravity IDE agent) from code — `engine/harness/antigravity.ts`
detects a live CDP endpoint or launches Antigravity with `--remote-debugging-port`,
attaches to the workbench window, and types+submits a command into the agent chat
("Message input" contenteditable). CLI `scripts/run_junior.ts` / `npm run junior`.
Verified live against Antigravity 2.8.1 (Electron 41 / Chrome 146): the agent
received and answered a command sent entirely by dept code. **Pipeline wiring
(`19d99dd`):** `junior.dispatch` now routes a `prompt` payload to the Antigravity
junior via a new override-able `antigravity-seam`, journaling the agent
transcript as an attributed `observation` span — verified live (dispatch
completed + observation journaled) and by `tc_dispatch_antigravity`. The model
picker was also driven from code to switch the junior off the rate-limited
Gemini 3.6 Flash onto **Gemini 3.7 Flash** (quota headroom). Known follow-up: the
transcript read is now hardened: `extractAgentReply` (pure, version-resilient)
isolates the agent's reply by slicing after the sent prompt and dropping IDE
chrome (timestamps, model-name label, input placeholder, open menus), and
`sendPrompt` presses Escape first so a stray model picker can't swallow focus —
verified live (clean reply "PIPELINE OK" captured). **Full operating manual:
`docs/antigravity-integration.md`** (components, CLI, pipeline usage, calibrated
selectors, rate-limit guidance, scars, tests). Two runtime scars
recorded: (1) `node --experimental-strip-types` forbids TS **parameter
properties** (`tsc` accepts them, the runtime does not) — use explicit field
assignment; (2) the main window's page title reflects the active chat, so match
the workbench by its `https://127.0.0.1` URL, not the title. Rate limit (Google
free tier) is an operational matter, not a code bug — the engine already handles
429 via model cooldown; the operator should pick a model with quota headroom
(Gemini 2.5/3.7 Flash were green; Antigravity Agents tier has 60 RPM) or enable
billing.

**Auto-kickoff flow — filed tasks start themselves; console owns a Runner
(2026-08-21):** two independent gaps had stranded filed tasks (filing
enqueued no work; the console started no Runner). Both closed: `fileTask` now
enqueues the `plan.cycle` job in the SAME transaction as the task insert
(deterministic id `plan.cycle:<taskId>` via `engine/jobs/ids.ts`, INSERT OR
IGNORE — idempotent by construction, `max_attempts:1`); a bounded reconciler
(`engine/flow/reconcile.ts`, every Runner tick) sweeps queued tasks with ZERO
cycle rows — failed cycles are NOT retried (explicit operator action); the
console (`opts.serve` only) runs a background Runner with
`excludeKinds:['intake.turn']` so it never races the inline intake drain
(`claimJob` gained a parameterized exclusion), plus a standalone `npm run
runner` that drains everything (durability/resume). Shutdown order:
`runner.stop()` → server close. The done-gate (verifier exit 0 + human
approval) is untouched — only planning auto-starts. Tests +14 (filing
kickoff/idempotent, reconciler stranded/idempotent/bounded/non-queued,
claimJob exclusion — all on fake AND real node:sqlite). Junior shipped no
mutation evidence; Senior executed and recorded **M-AK1** (deterministic id —
4 failures), **M-AK2** (kind exclusion — 2 failures), **M-AK3** (reconciler
NOT EXISTS — NOT caught, correctly: the id constraint redundantly blocks
re-enqueue; defense-in-depth) in `docs/mutation-evidence-phase7.md`. Merged
`64d33cd` after Senior verdict `f8aceeb` for `592dc09`. **Operator advisory:
the stranded "Department Assets" task (`82b97764…`, verified queued with zero
cycles) will auto-kick a REAL plan cycle on the next console/runner start —
supervise it or park it first.**

**Assets tab + first-run fixes + bounded work-review loop (2026-08-24, merged
`c7f9b37`):** the first real run (task `82b97764`, transcript committed as
`146f427`) drove the whole flow and exposed four gaps, all closed on
`wt/junior-assets-tab` (feature tip `05dd8fb`, Senior verdict `0a1100a` /
`docs/reviews/verdict-assets-tab.md`): (1) **dead backup** — `backup-seam.ts`
called `require()` in an ES module so every `backup.push` died since 08-20; now
a top-level import (regression `tc_backup_seam`). (2) **Plan→work loop closed**
— plan approve/ceiling transitions `queued→claimed` (no zombie), the
implementation dispatch chains `work.cycle` in the dispatch-completion
transaction, prompts are honest (the ceiling path never claims APPROVED and
threads the senior's final required changes). (3) **Bounded work-review loop**
(`engine/flow/work_review_cycle.ts`) — on REVISE the fixes go back to the SAME
junior (conversation continued, `chainWorkReview`), re-reviewed by the SAME
senior until APPROVE, bounded by `review:work_rounds_ceiling` (default 5) at
which the task is **blocked** for the operator; `cycles` counts rounds
transactionally. (4) **Department Assets tab** — `bureau_assets` CRUD behind
the fail-closed token check with `safeHref` XSS guard (`javascript:`/`data:`
render inert). Policy change (reviewed + accepted): the **plan** ceiling no
longer blocks — it proceeds to implementation with feedback threaded and the
walkthrough review gates (ceiling raised 3→7). Done-gate untouched (empty diff
over `state/machine`, verify, filing, intake — Senior-verified). Suite 340/340
across 81 files on merged main, build clean; Senior re-executed M-HREF and
M-WLOOP live (both reproduced → restored → green). Still open: the harness
junior writes in its own IDE workspace, not a bureau worktree, so automatic
`verify.run → needs-review` against the junior's branch remains a separate
stream.

**Phase 7 Stream A — multi-key Google provider + rate-limit steering
(2026-08-21):** the officer's un-provisioned Ollama backend is off the
critical path. `callModel` now rotates over (model × key) pairs — on a 429 it
cools the specific pair (`cooldown:<model>:<keyIdx>`) and tries the next key,
then the next model — and steers proactively: `eligibleGoogleKeyPairs` reads
live RPM/RPD/TPM per pair from the journal and rides the flash-lite 500/day
pools (limits transcribed from the operator's AI Studio page into
`GOOGLE_MODEL_LIMITS`), spilling to the 20/day flash models only when
saturated, Ollama last. Versioned reseed `seedGoogleRosterV2` (own meta key —
reaches the live non-empty DB): officer → `gemini-3.1-flash-lite`, junior →
`gemini-3.5-flash-lite` (roster/legacy-path only; the live junior stays the
Antigravity harness), senior untouched. **Settings → Google API keys**:
two masked fields; save validates `AIza…` shape, writes process.env +
gitignored `secrets/google.env` (0600), enables the roster live (no restart),
and journals `{ count }` only — never key material (T18; whole-DB scan test).
Keys load at boot in both entrypoints (runner CLI + console) before the seed;
explicit env wins over the file. Officer spans carry the serving slot
`gkey-N`. Tests `tc_google_provider` (9) + `tc5_settings_keys_api` (3);
mutations M-G1 (key hygiene — Senior re-executed: raw-key attribution fails
3 tests incl. the whole-DB scan) + M-G2 (RPD steering) in
`docs/mutation-evidence-phase7.md`. Merged `a74131d` after Senior verdict
`65a0d5e` for `df7f442` (`docs/reviews/verdict-google-provider.md`). Still
open: A2 `[llm]` provider-doubling, A3 budget-refusal proof; first live
Gemini officer turn is an operator activity.

**Console conversational intake — task-creation front door (2026-08-21):**
the Operator Console can now originate tasks, not just view/approve them.
"+ New Task" opens a chat with the real Task Intake Officer over four new
token-auth endpoints (`POST /api/intake`, `GET /api/intake/:id`,
`POST …/reply`, `POST …/confirm-file`) that wrap the Phase 1 engine helpers —
the same `runOfficerTurn` / `intake.turn` path the CLI uses, no intake logic
duplicated. The operator writes plain English; the officer drafts every field
including the verify command, which the operator only **approves**
(`confirmVerify` + `fileTask`, human-operator attribution — the confirm-verify
gate is untouched and contract-enforced). Turns drain inline; `runIntakeTurn`
re-reads the job row because `drainSingleJob` swallows failures, surfacing
non-`done` as 502 + guardrail span. ENDPOINTS 8 → 12 (`contract_d0_c`
updated). Tests `tc4_intake_api` (7); mutation evidence M-INTAKE-1 (human
gate — Senior independently re-executed: removing `confirmVerify` fails the
gate test via `fileTask`'s own `verify_confirmed` gap refusal) + M-INTAKE-2
(502 surfacing) in `docs/mutation-evidence-console.md`. Merged `baa5b74`
after Senior verdict `bbdf221` for `11b4ad9`
(`docs/reviews/verdict-console-intake.md`). Live LLM behavior (Ollama
latency/timeouts) untested by design — fakes only per test law; first live
use is an operator activity.

**Adaptive completion wait — no hard cap on junior/senior time (2026-08-20):**
replaced the fixed-ms completion ceiling with `engine/harness/agent-wait.ts`
(`waitForAgentIdle`): poll the agent and keep waiting AS LONG AS it's working
(Stop/Cancel control, Working/Generating/Thinking indicator, or transcript still
growing) — no elapsed-time cap; stop only on genuine completion (idle + text
stable across polls) or a real stall (inactive with no progress for `stallMs`,
default 120s). Wired into both `AntigravitySession.waitForCompletion` (junior)
and `ZCodeSession.waitForCompletion` (senior); seams pass `stallMs`, never a hard
ceiling. Unit-tested (`test/unit/tc_agent_wait.test.ts`, 4 tests incl.
"actively-working agent is never cut off"). Live: the ZAI work-review kept being
waited on past 10 min because GLM was genuinely still auditing (re-ran the suite,
opened Terminal/Browser panes) — the adaptive waiter behaved correctly; the only
cap hit was the operator's own 10-min tool limit. Open follow-up: GLM's deep audit
spawns ZCode **side panes** (Terminal/Browser/Review) so its final verdict can land
outside the main transcript — a ZCode capture calibration, separate from the wait.
Suite 271/271. Also: **one-junior-per-task** (`assignJunior`, deterministic by task
id, spreads tasks across A/B for parallelism, never both on one task) and a live
end-to-end real task — **Settings tab added to the Operator Console** (junior B
planned, ZAI approved the plan against the task verbatim, junior implemented on
branch `wt/console-settings`, verified build+267 tests+live browser, merged to main
`03985ef` fast-forward).

**Plan-review cycle wired — junior authors, senior reviews (2026-08-20):** the
seniors are now IN the department flow, in the corrected order. New
`engine/flow/plan_review_cycle.ts` (`runPlanReviewCycle`): TASK → junior
(Antigravity) AUTHORS a plan-only (`buildJuniorPlanPrompt`, task embedded, 25s
wait) → senior (Claude/ZCode) REVIEWS it **with the task verbatim** (title +
intent + spec + acceptance, so it judges plan↔task alignment). Writes real
`bureau_plans` (actor=junior-engineer/antigravity) + `bureau_plan_reviews`
(approve→approved/revise→amend) rows, an `observation` + a `review` journal span,
and increments `plan_rounds`. CLI `scripts/run_plan_cycle.ts`. **Verified live:**
junior B authored a temperature-converter plan; the Claude senior reviewed it
against the spec/acceptance and returned APPROVE (and in an earlier run correctly
caught a plan-capture bug — REVISE with a precise diagnosis). `buildReviewPrompt`
now includes the task verbatim for all senior reviews. Suite 265/265. NOTE: this
is a new orchestration path using the harnesses; the legacy `senior.review-plan`
job (internal `callModel`) is untouched for now. Manual: `docs/senior-integration.md`.

**Two-senior integration (2026-08-20, direct on main):** the department now
drives its **seniors** from code too — seniors review (never code) the junior's
captured plan/walkthrough and return a fail-closed `approve|revise` verdict.
**claude** = the Claude Code CLI (`claude -p --append-system-prompt`, subprocess),
authed against api.anthropic.com; **zai** = ZCode, the Z.ai GLM desktop agent
(Electron/Chromium, CDP-driven on port 9335, exactly like the juniors). New:
`engine/harness/senior.ts` (`SENIORS` registry, pure `buildReviewPrompt`/
`parseVerdict`, `ClaudeCliSenior`, `ZCodeSession`+`ZCodeSenior`), override-able
`senior-seam.ts`, `readLatestArtifacts` (reads `docs/junior-artifacts/`),
`scripts/run_senior.ts`. **Verified live (both seniors):** the Claude senior approved a
right-sized clicker plan and flagged an over-engineered one as REVISE; the ZCode
(GLM-5.2) senior, driven over CDP on 9335, reviewed the same plan and returned
APPROVE — both writing no code. **Single-reviewer assignment** (`assignSenior`):
one senior per artifact (default plan→claude, walkthrough→zai; env
`SENIOR_PLAN`/`SENIOR_WALKTHROUGH`/`SENIOR_DEFAULT`) — never both, since that's
wasteful. **Model selection both:** Claude via `--model`; ZCode via the in-GUI
"Choose model" picker (`ZCodeSession.selectModel`, live-tested on GLM-5.2).
**Quota:** ZCode `readUsage()` ("Usage remaining" control); Claude via `/usage`
in-app or console.anthropic.com (`usageHint`). ZCode calibrated live: workbench is
a `file://…app.asar/out/renderer` page, input `div[role=textbox][contenteditable]`,
Send `aria-label="Send"`. Scar: ZCode runs a persistent tray process, so "quit"
leaves it alive holding the single-instance lock — must kill all ZCode procs before
relaunching with the debug flag. Suite 262/262, build clean. Manual:
`docs/senior-integration.md`.

**Two-junior integration (2026-08-20, direct on main):** the department now
drives **both** Antigravity Pro accounts as juniors — **A** = Antigravity IDE
(port 9333), **B** = Antigravity 2.0, the standalone agent app (port 9334). One
CDP driver runs both (same DOM landmarks, calibrated live): `JUNIORS` registry +
`resolveJunior`/`ensureJuniorRunning`/`findJuniorBinary` in `antigravity.ts`;
`AntigravitySession` gained `selectModel` (GUI picker), `selectFolder` (workspace
picker), and `captureArtifacts`. Scar: **Antigravity 2.0 does not submit on
Enter** — it needs the "Send message" button; `sendPrompt` now presses Enter then
clicks Send if the input still holds text, and clears stale drafts with real
Ctrl+A/Delete key events (raw `innerText=''` is ignored by the contenteditable
framework and left text to double). `junior.dispatch` accepts `junior`/`model`/
`folder`, journals `{ junior, model, folder, hasPlan, hasWalkthrough,
artifactFiles }`, and persists plan/walkthrough/full-output to
`docs/junior-artifacts/<taskId>/`. **Verified live:** Junior B selected a model
and answered "TWO JUNIORS OK" end-to-end via `run_junior.ts --junior B`. Suite
248/248, build clean. Follow-up: refine `PLAN_MARKERS`/`WALKTHROUGH_MARKERS`
against the first real task that emits a plan/walkthrough; calibrate Junior A's
send path (it may already submit on Enter).

**Phase 6 note:** the console streams were each unit-tested but not wired end-to-end
— `scripts/console.ts` minted the token and opened the browser but never started
`createConsoleServer`, so the desktop shortcut opened a dead port. Caught at
Operator integration (not a milestone Senior review, since neither stream owned
the seam), fixed in `eb39d36` (launcher starts the server, gated behind
`opts.serve` so B3 unit tests don't bind), and verified with a live HTTP round-trip.
Desktop + Start-Menu shortcut ("Department Console.lnk") installed via
`scripts/install_console_shortcut.ps1`. The "unit-green but never integrated"
gap is the same lesson as Phase 5's "never driven end-to-end" — carried to
Phase 7's live-operation scope.

**Flake fix (2026-08-18, operator, branch `wt/operator-flake-ledger`):** the
full suite was non-deterministically red — 4 heavy integration tests
(`t4_crash_resume` T4b, `t28_crash_safety`, `t38_demo_phase3`, `t44_pr_merge`)
failed under full-suite parallel load and passed in isolation. Root cause was
cross-file parallelism: tests that spawn real child processes (crash-kill) and
real browsers contend for CPU/process slots, breaking exactly-once and timing
assertions ("expected 1 to be +0", lease-reap timeout). Fix in
`vitest.config.ts`: `fileParallelism: false` plus `testTimeout`/`hookTimeout`
20s. This is the Phase 5 "Flake hardening" item paid down early; the deeper
move (deterministic sync on DB rows/browser events instead of wall-clock
polls) remains Phase 5 scope.

## Phase ledger

| Phase | Scope | Status |
|---|---|---|
| 0 — Foundation | Engine package, full schema (budgets as columns), jobs runner with claim/lease/reap, journal, migration door | ✅ done, merged |
| 1 — Intake | Filing door, intake sessions, Task Intake Officer over Ollama/Gemini, `intake.turn` job, CLI, durability, T9–T18 | ✅ done, merged (`cf0901f`), exit demo verified |
| 2 — Worktrees + Verifier | Worktree manager, checkpoints, deterministic verifier, verify→fix loop bounded by `verify_fixes` | ✅ done, merged (`3053145`), exit demo verified on main |
| 3 — Junior harness | CDP client, selector registry + calibration gate, nonce correlation, window lease | ✅ done, merged (`6618608`), exit demo verified on main |
| 4 — Senior + gates + delivery | Plan/work review, operator approval, PR creation, merge with worktree cleanup | ✅ done, merged (`a8711e9`) — D0 freeze (`e0efd42`), Stream A review gates (`732fbbe`), Stream B delivery (`a8711e9`) |
| 5 — Hardening | Watchdog, backup push, Secretary, dashboards, red-team, flake fix | ✅ **done** — D0-5 (`9a56b8e`); Stream A A1–A3 (`ea4ff0a`); Stream B B1 backup (`23a5a8f`), B2 dashboards, B3 red-team, B4 deterministic-wait (`wt/junior-b-hardening-2`). Exit sentence demonstrated via `scripts/demo_phase5.ts`. |
| 6 — Operator Console | Local web control panel + desktop shortcut: dashboards, findings, task states, approve/trigger actions | ✅ **done** — D0-C (`59acc69`), Stream A backend (`fc97549`), Stream B frontend+launcher (`8944670`), live-server wiring (`eb39d36`). Verified live; desktop shortcut installed. |
| 7 — Live operation | First real LLM-driven task end-to-end (real model + real IDE + sandbox repo, supervised) | 🔄 **in progress** — Stream A provider reality merged (`a74131d`). **First real task shipped end-to-end and merged (`c7f9b37`): filed → plan review → implement → bounded work-review → ZAI-approved merge; the plan→work flow loop is closed.** Remaining: workspace/worktree reconciliation (auto `verify.run → needs-review` from the junior's branch — the last gap to automatic `done`), A2 `[llm]` provider-doubling, A3 budget-refusal proof, C1 delivery against a sandbox remote. |

Phase 5 progress record (as of 2026-08-18): D0-5 contract freeze, Stream A
(A1–A3), and Stream B B1 merged; suite 196/196 across 58 files, green twice on
merged main, build clean. Senior re-executed representatives of each stream's
mutation evidence (M-A1 `verifying` predicate, M-A3 fail-closed lease, M-B1
remote-tip readback) and confirmed A's read-only proof is a genuine before/after
snapshot, not a self-filtering test. The mini-freeze (`subject_kind`,
`subject_id`, per-finding `recover_attempts` on `bureau_watchdog_findings`) fixed
the plan-review gap that the findings table had no generic subject reference; the
partial unique index was correctly sequenced in `applyBootMigrations` after
`applyAddedColumns`. Incidents, all caught at Senior review, none reaching main:
Stream B's first B1 submission (`a66ede2`) shipped a **false "build clean" claim**
while `registry.ts` wired `watchdog.sweep` to `../watchdog/sweep.ts` — Stream A
code absent on B's branch, so `tsc` failed (TS2307); the 180 tests passed only
because no test triggers that dynamic import. This is the **second cross-stream
registry contamination** (first was `32518bd` in Phase 4) and a repeat of the
fake/greenwashed-claim pattern — walkthroughs are re-built and re-run, never
trusted. Repaired by reverting the block to its D0-5 stub (`23a5a8f`) and
re-verified. Minor debt: the M-B1 evidence log still cites the pre-rename test
path `backup_push.test.ts` (now `t48_backup_push.test.ts`) — a stale reference,
not a functional defect.

Phase 5 closing record: all milestones merged; suite 202/202 across 60 files,
green twice, build clean, `demo:phase5` exit 0. B2 dashboards (`engine/dashboards/`,
`scripts/dashboard.ts`, T49 read-only proof), B3 standing red-team suite (T50:
env-scrub/output-redaction, selector-spoof gate refusal, verify-command tampering),
B4 deterministic-wait helper (`test/helpers/wait.ts`, T4b converted). Mutation
evidence M-B2/M-B3/M-B4 recorded and reproduced. Residual debt carried forward:
`fileParallelism:false` remains because the browser tests (t28/t38) still use
wall-clock waits — B4 converted only the T4b poll; retiring the band-aid needs
those two moved to browser-event synchronization.

## Beyond Phase 5 — candidate next phases (not yet frozen)

Phase 5 completes the "survive its own failures" arc. Nothing beyond it is
recorded yet; these are the honest candidates, to be turned into a real plan the
same way (rough → frozen plan → D0 contract freeze → streams):

- **Phase 6 — Live operation / control loop.** The pieces exist as jobs but have
  never been driven end-to-end by a real LLM against a real IDE on a real task.
  A supervised "one real task, start to merge" run: intake → plan → junior
  dispatch → verify → senior review → operator approve → PR → merge → backup,
  with the watchdog and dashboards live. This is the gap between "the machine is
  built and unit-proven" and "the department has actually shipped a change."
- **Phase 7 — Provider hardening & cost.** The `[llm]` provider-doubling
  attribution bug is still open; real runs will surface token/cost accounting,
  ret/timeout tuning, and model-selection policy. Budgets exist as columns but
  have not met a real bill.
- **Phase 8 — Multi-task / concurrency at scale.** Today's proofs are one or two
  tasks. Running many concurrent tasks/windows exercises the Secretary, lease
  contention, and the watchdog under real load — and is where the retained
  `fileParallelism` debt and the t28 browser-contention flake actually bite.
- **Cross-cutting debt to clear first:** retire `fileParallelism:false`
  (browser-event waits for t28/t38); fix `[llm]` provider doubling; the stale
  M-B1 evidence path.

Phase 3 closing record: T30–T38 green on main; nine mutation evidences
recorded (C0 ×4, Stream A ×3, Stream B ×2, CX ×3) with the Senior
independently re-executing representatives of each class (C0 partial index,
A3 finally-release, B gate check, CX-a composite revert). Exit sentence
demonstrated: exclusive window lease, calibrated-selector gate unbypassable
via the Runner's default `GatedIdeDriver(CdpIdeDriver)` composite, nonce
triple-equality (span detail = observation = driver echo) verified in T36
and the demo, crash safety with no orphan nonces, zero process leaks.
Incidents, all caught at Senior verification, none reaching main: five
false-citation/claim incidents from Stream A (36/135, 41/145 twice, 42-file
plan arithmetic, demo "clean exit 0" + T38 "clean teardown" while the demo
hung and leaked a browser tree); Stream B's C0 evidence rewrite and false
registration claim; one cross-stream contamination (B's `8dd95f3` reset off
A's branch by the Senior); CX round 1's hollow mock wiring (engine fallback
impersonating the model — proven by the hard-coded value landing in the
journal) and browser leak, both repaired and re-verified. The fake-mutation
pattern is now the department's most persistent failure mode: walkthroughs
are re-run, never trusted. Carried to Phase 4 backlog: `[llm]` span provider
doubling (`ollama/ollama`) — cosmetic attribution bug in dispatch→callModel;
`t28_crash_safety` flake under parallel browser load (one failure in three
post-A/B runs, quiet since).

Phase 2 record: T19–T29 green; both mutation evidences (T19 refuse-dirty,
T26 fixes-increment) re-executed independently by the Senior; `demo:phase2`
run on merged main (25 attributed spans, key hygiene PASS, zero fail spans).
Process note for every future phase: Phase 2 had five incidents of commits or
merges reaching main before a posted Senior verdict (a0a82cf, 9f018ac,
23535a3, the 6800506 merge, 44f76fd) plus one completion claim written into
this ledger while WX was still unmerged. Every one was caught and repaired,
and the final WX merge (3053145) followed a posted verdict — but the law is
absolute: nothing reaches main without a posted Senior verdict, and ledger
"done" rows cite the hash that actually contains the work.

Definition of done for a phase: merged to main, suite + build green on main,
exit sentence demonstrable (demo script or recorded test evidence), and this
ledger updated by whoever merges.

## Operating protocol (the review loop)

This is the loop every stream follows. It was proven across Phase 1.

1. **Operator** opens a window per junior and assigns a stream from the phase
   plan. One branch per stream: `wt/junior-<x>-<stream>`, cut from main after
   the contract-freeze milestone merges.
2. **Junior** posts a plan (components, files, tests) for Senior review BEFORE
   writing code.
3. **Senior** reviews the plan; blockers and amendments are resolved first.
4. **Junior** implements on the branch. Every PR names the guard it broke and
   the test that caught it — real mutation evidence, recorded in
   `docs/mutation-evidence-phase<N>.md`.
5. **Junior** posts a walkthrough with claims (test counts, demo output).
6. **Senior** verifies claims independently: runs the suite twice, the build,
   the demo, inspects the journal — then approves or lists defects.
7. **Operator** merges to main and updates this ledger.
8. Switching windows mid-phase is fine IF the "In flight" row above is filled
   in first (branch, tip commit, what remains). An empty "In flight" means a
   clean handoff.

## New-window checklist (any role)

1. Read this file.
2. Read the current phase plan doc (`docs/phase-3-plan.md` right now;
   Phases 4–5 exist as rough outlines in `docs/phase-4-rough.md` /
   `docs/phase-5-rough.md`).
3. `git log --oneline -10` and `git status` — tree must be clean, branch known.
4. `npx vitest run` and `npm run build` — must be green before any work starts.
5. Follow the review loop above. Never work directly in main's tree.

## Scars — rules written from real incidents

- **The out-of-band-merge incident (2026-08-24/25):** the two real shipped tasks
  (`82b97764`→`c7f9b37`, `e489b734`→`1c14534`) reached `main` by a **hand
  `git merge`**, and their `docs/junior-artifacts/` transcripts by a hand
  `git commit`, done by a peer session outside the department's machinery. The
  live DB proved it: **zero** `verify.run`/`pr.create`/`pr.merge` jobs for either
  task, zero merge journal spans, and the task rows stranded at `queued`/
  `claimed`. Root cause: the harness junior works in its own IDE workspace, not a
  bureau worktree, so `verify.run` never runs against its branch and the tracked
  delivery path (`verify.run → needs-review → approve → pr.create → pr.merge →
  done`) is never reached — the flow dies at `work.cycle`. Rule: **every merge to
  `main` is a tracked act** (a `bureau_jobs` row + `journal()` span + task state
  transition); no hand-merges/commits to `main` outside the flow. Hand-merges are
  **paused** until the workspace/worktree reconciliation stream wires `verify.run`
  against the junior's real branch. Closing out shipped work uses the Completed
  tag / Archive (orthogonal to `state`), never a forged `done`.
- **The gitignore incident:** an unanchored `db/` pattern silently kept
  `engine/db/` out of Phase 0's commits; main could not build. Anchor ignore
  patterns (`/db/`, `/.bureau-worktrees/`), and after any oddity run
  `git status --ignored` and check source dirs are tracked.
- **The uncommitted-main incident:** a whole milestone sat as untracked files
  in main's working tree. Branches are mandatory; "done" means committed on a
  stream branch and merged by the Operator.
- **The live-DB incident:** a demo wrote a fake queued task into
  `db/bureau.db`. Tests and demos use temp paths only and clean up after
  themselves; the live DB is bureau property.
- **The fake-mutation incident:** a "mutation test" that filtered its own
  input proved nothing. A mutation means: mutate the real code, watch a real
  test fail, restore, record the logs.
- Claims in walkthroughs are verified, never trusted. Suite runs twice (flake
  check), build, demo, journal inspection.

## Standing invariants (all phases)

One SQLite store (boot-migration via `ADDED_COLUMNS`); nothing fire-and-forget
(every async step is a job row); budgets are columns incremented
transactionally with the state they bound; one journal door with full
attribution; API keys live in env only; no network in tests; verify commands
are bureau-owned and never read from a workspace; the DB refuses what the
rules forbid (CHECK constraints), and no code path bypasses it.
