# Department of Code v2 — Department Status Ledger

**This file is the department's memory across sessions and windows.** Every new
session (Senior, Junior, or Operator) reads this file FIRST, then the current
phase plan, then git. Nothing important lives only in a chat window.

---

## Current status

| | |
|---|---|
| **Phase** | **Phase 6 — Operator Console: COMPLETE. D0-C + Stream A (backend) + Stream B (frontend/launcher) merged; launcher wired to the live server; desktop shortcut installed.** |
| Main | D0-C (`59acc69`), Stream A (`fc97549`), Stream B (`8944670`), launcher integration fix (`eb39d36`). Prior: Phase 5 at `8974b0f`. All Senior-verified. |
| Suite | 238/238 tests, 69 files, `npm run build` clean on merged main. Antigravity junior driven from code AND via the `junior.dispatch` pipeline; agent-reply capture hardened (clean reply verified live). Full manual: `docs/antigravity-integration.md`. Prior: 232/232 at console completion. |
| In flight | Nothing. Clean handoff point. |
| Next action | **Phase 7 in progress → `docs/phase-7-plan.md`.** Antigravity junior drive-layer landed (`9447e7e`) — a Stream B down-payment. Remaining: real LLM provider wiring + the two live findings (role→model fallback to Google when Ollama is down; seed model id `gemini-2.5-flash` 404s but `gemini-flash-latest` works), then the C1 supervised end-to-end run. Gemini key is live (`.env`, gitignored). |

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
| 7 — Live operation | First real LLM-driven task end-to-end (real model + real IDE + sandbox repo, supervised) | 🔄 **plan frozen → `docs/phase-7-plan.md`** — D0-7 harness freeze, Stream A provider reality, Stream B IDE reality, C1 supervised live run. To be executed by a fresh window. |

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
