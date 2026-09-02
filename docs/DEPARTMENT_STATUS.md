# Department of Code v2 — Department Status Ledger

**This file is the department's memory across sessions and windows.** Every new
session (Senior, Junior, or Operator) reads this file FIRST, then the current
phase plan, then git. Nothing important lives only in a chat window.

---

## Current status

| | |
|---|---|
| **Phase** | **Phase 7 close-out DONE + Part-A improvements A1–A5 all merged (2026-08-26). Roadmap `docs/plan-bureau-kernel-roadmap.md` Part A executed: A1 merge-law git hook + delivery-tail lock, A2 attribution/budget/sandbox-remote, A3 staged verification (D0 + impl), A4 test determinism (retired `fileParallelism:false`), A5 real cost accounting. Each senior-reviewed (Claude CLI headless) and merged `--no-ff` to local main. Plans for the next phases now recorded: `docs/phase-8-plan.md` (concurrency), `docs/phase-9-plan.md` (Bureau Kernel extraction + Department Kit), `docs/phase-10-plan.md` (first real new department).** |
| Main | D0-C (`59acc69`), Stream A (`fc97549`), Stream B (`8944670`), launcher integration fix (`eb39d36`). Prior: Phase 5 at `8974b0f`. All Senior-verified. Latest: console intake `baa5b74`; Stream A google-provider `a74131d`; auto-kickoff flow `64d33cd` (feature `592dc09`, Senior verdict `f8aceeb`); **assets-tab flow `c7f9b37`** (feature tip `05dd8fb`, Senior verdict `0a1100a`); **ntfy flow `1c14534`** (feature tip `f349a13`, Senior verdict `d398b53`); **console task archive + Workers flow view + senior conversation reuse `1710098`** (features `27b85e5` + `60be286`, Senior verdict `docs/reviews/verdict-console-archive-flow.md`). |
| Suite | **582/582 tests, 109 files, `npm run build` clean on origin/main `40e4157` (2026-08-28).** (was 479/101) **Two seniors drivable** (claude = Claude CLI subprocess; zai = ZCode/GLM CDP GUI @9335) — review-only, fail-closed verdicts, both verified live; single-reviewer assignment, model selection + quota for each; manual `docs/senior-integration.md`. Console has a **Workers tab** (`GET /api/workers` + `GET /api/flow` pipeline stepper, `workerRoster`/`taskFlow`) — department roster with live active/idle status plus per-task stage + stuck flag, verified against `db/bureau.db`. **Two juniors now drivable** (A = Antigravity IDE @9333, B = Antigravity 2.0 @9334) from code + via `junior.dispatch` (`junior`/`model`/`folder` payload fields); GUI model + folder selection, plan/walkthrough/full-output captured to `docs/junior-artifacts/`. Manual: `docs/antigravity-integration.md`. |
| In flight | **2026-08-30/31 — two NEW department-filed tasks at `needs-review`, both approve-ready after an operator fix this session:** `3756ec6e` ("hello marker", Trading repo — clean, tip==reviewed `86cccba`) and `b55e2fda` ("window-lease heartbeat" = the P1.2 fix, this repo). b55e2fda was **unblocked**: its only gate was a `phase='walkthrough'` review at `9186a05` but the branch had advanced to `c126a68` (test-only fixes), so `pr.create` would have refused (`reviewed_commit != tip`); a real **phase4 code-diff** senior verdict was recorded at the tip (Claude Opus 4.8, `docs/reviews/verdict-b55e-heartbeat-tip.md`, full suite **646/117 green** at `c126a68`). Both now pass every `pr.create` precondition — operator: Approve in the console to deliver. **This run was the first 2-task-concurrent flow and it exposed that concurrency is NOT yet safe** (juniors shared one window/chat → cross-contamination); the full findings + tomorrow's plan are in `docs/plan-pre-phase8-remaining.md` (**2026-08-30 session findings, N0–N7**). Also present: an orphan `needs-review` test artifact `live-mt0xgoxz` ("Add subtract() to math.js") to archive. — Historical below. **Two 2026-08-28 department-filed tasks were at `needs-review`:** `7ef423f2` (POSIX `pkill -f`→`-x` hardening) and `5d29e47b` (scale-aware senior assignment via new `SENIOR_SCALE_DEFAULT`). Both ran the FULL flow unattended (intake→plan→junior implement→claude review→staged verify exit 0→needs-review), worktrees clean, `reviewed_commit` == branch tip. Historical: **PUSHED to origin/main `1708e3d` (2026-08-27):** the agent task-filing door AND the **Phase 8 entry fix pack F1–F6** (delivery-tail drill scars). Fix pack: round-1 claude senior REVISE (F4/F5 fake tests — tested reimplementations) → amend (real exported `resolveClaudeSeniorTimeoutMs`+`resolveIntakeSession` the tests import; F6 PLAN_MARKERS; **timeout default 180000→1200000 / 20 min, operator-set — durable, so the F4 scar no longer strands tasks**) → **zai (ZCode/GLM-5.3) senior APPROVE** (9m agentic review, re-ran build+suite 519/519 ×2 + re-executed M-TAIL-1/2 and the F4/F5 revert-mutations; verdict `docs/reviews/verdict-phase8-fixpack.md`) → `--no-ff` merge `1708e3d` → 519/519+build clean on main → pushed. Task `e156395d` Completed-tagged (commit `1708e3d`, not forged done). **Remaining pre-Phase-8 dev work = Stream B (provisioning console) FILED through the agent door (`1429a7de`) and RESUMED after two harness stops:** door→auto-kickoff→plan.cycle claim→**junior A (Antigravity) authored the plan**; the F4 timeout no longer bites. Stop #1 (RESOLVED, recalibration `995f6d8`): the zai/ZCode senior harness failed on ZCode 3.9.2 (empty home screen captured; `detectUncapturedReview` correctly refused → plan.cycle died fail-closed). `ZCodeSession` recalibrated for 3.9.2 — composer `[data-testid="v4-composer-input"]` (3.9.2 has no aria-label/placeholder), model picker `chat-model-select-trigger`, new-conversation `conversation-new-task`; send/stop unchanged — proven by a 39s smoke review AND in-flow: 5-round plan review with 4 real zai verdicts (rubric amend, then REVISE ×3, then **APPROVE round 5**, review `365c926f`). Stop #2 (NEW, 2026-08-27 10:41–10:42 UTC): on approval the implementation `junior.dispatch` (dispatch `eb5b0aaa`) died terminally — the Antigravity instance was down/wedged when the worktree window was requested ("opened a window … but no CDP window titled `<taskId> - Antigravity IDE` appeared"), 3 attempts burned → job dead at `claimed`. **Operator resume (11:12 UTC):** clean-relaunched junior A with `--remote-debugging-port=9333` (restored session reopened the worktree window under the EXACT expected title — the title heuristic is NOT the defect; the dead instance was), re-enqueued the identical payload through the engine's own `enqueueJob` (job `af75acf6`, journal #632) → dispatch claimed, junior implementing in the worktree (transcript confirmed growing, tracing `engine/projects/provision.ts`). Scar: a `junior.dispatch` that exhausts attempts is NOT auto-retried (by design) — recovery = ensure the junior GUI is up with its debug port, then re-enqueue the same payload via `enqueueJob`. Known wart: long GUI dispatches always get their 2-minute window lease reaped (`heartbeats: 0`, no renewal path) — harmless while no competing dispatch wants `window-default`; heartbeats are a candidate follow-up. Convergence run (supervised `gh`) still an operator activity. Agent task-filing door MERGED to local main `67eb81f` (`--no-ff`) — 2026-08-27, senior APPROVE (verdict `docs/reviews/verdict-agent-task-door.md`; suite 502/502 ×3 with only the intermittent `t4` parallel-load flake, build clean, M-AGENTFILE-1/2 re-executed live).** One engine helper `fileAgentTask` (`engine/filing/agent_file.ts`) + CLI `npm run task:file` + `POST /api/tasks/file` (ENDPOINTS 30→31); actor allowlist + fail-closed `intake:agent_autofile` meta opt-in + vacuous-verify/field gates + session-layer idempotency; auto-confirm attributed to the agent (`confirmVerify` untouched, human-only); attribution claude=`senior-engineer/anthropic`, glm=`senior-engineer/zai`. Suite 502/502 ×2, build clean; M-AGENTFILE-1/2 recorded (`docs/mutation-evidence-phase8.md`); e2e on temp DB (flag-off refusal, opt-in, HTTP 401/403/201, GLM stdin relay, idempotent retry); walkthrough `docs/walkthrough-agent-task-door.md`, plan `docs/plan-agent-task-door.md` (untracked). DONE for this stream (verdict posted + `--no-ff` merged to local main `67eb81f`, re-verified 502/502 + build clean on merged main). NEXT: opt in with `npm run task:file -- --enable` and file the first real task through the live door — the flag stays OFF until the operator does; push to origin is the operator's call. Prior follow-ups still open from the 2026-08-26 drill: (1) wire `GhCliPrProvider` (+ workspace provider) into runner/console boot — tonight's pr.create/pr.merge were drained by an operator-side process with the seams set because NO runtime path registers a PrProvider; (2) delivery-branch model: the junior committed on `wt/junior-a-project-provisioning` inside the worktree while `bureau-wt-<taskId>` stayed at base (operator fast-forwarded + journaled) — either the worktree manager forces the bureau branch or pr.create uses the worktree's real branch; (3) ✅ RESOLVED by the fix pack: `CLAUDE_SENIOR_TIMEOUT_MS` default is now 1200000 (20 min) on main — relaunch any runner/console to pick it up; (4) plan rubric vs conversational junior replies burned round 3; (5) Stream B (console UX) + the supervised `gh repo create` convergence run for the new provisioning engine. Ledger + plan-doc commits are the operator's call (files deliberately untracked). |
| Next action | **2026-08-30/31 update:** (1) **Approve `3756ec6e` + `b55e2fda`** in the console — both are unblocked and pass all `pr.create` preconditions. (2) Before any ≥3-concurrent run, land the P0s from the new run: **N0** (junior "completion" fires before the agent is done) and **N3** (junior-B bypassed → both tasks shared junior A and contaminated each other), then **N1/N2** (verify-sendback advances the tip past `reviewed_commit`; delivery gate can be a plan review not a diff review). (3) Decide **N6** (six evening merges landed with no verdict docs — ratify or retro-document) and resolve the merge-law policy tension. See `docs/plan-pre-phase8-remaining.md` **§2026-08-30 session findings** for the ordered plan. Archive the orphan `live-mt0xgoxz`. — Prior (2026-08-28): **Phase 8 entry gate CLEARED** — origin main green + pushed (`40e4157`), Stream B shipped (PR #2), full flow unattended (proven twice). Immediate: (1) approve the two `needs-review` tasks in the console to close them; (2) the supervised provisioning convergence run (entry-gate step 3, operator-supervised); (3) begin **Phase 8 proper** — file **≥3 tasks concurrently** and exercise the Secretary, lease contention, and watchdog under load (`docs/plan-pre-phase8-remaining.md` = the P0/P1/P2 punch list). Then Phase 9 (kernel extraction) and Phase 10 (first new department). Loose ends carried forward: the A1 merge-law hooks are **NOT installed in-repo** (`npm run hooks:install` would block the department's own engine-development merges — resolve that policy tension first); the intake `acceptance_tests` drafting needs a `bureau_intake_sessions.acceptance_tests` D0 addendum (the A3 staged verifier already consumes `task.acceptance_tests`); A5 prices are operator-set via `setModelPrice`/meta (unset ⇒ honest "unpriced floor", see `npm run cost:report`). Gemini keys live; ceilings in `bureau_meta`. |

**PRE-PHASE-8 SESSION (2026-08-31) — N8, N1(b), N9 all fixed + PUSHED to
origin/main.** Three pre-Phase-8 P0 code fixes were worked as engine-dev (branch →
claude-senior review → `--no-ff` merge → re-verify), then pushed. Origin/main
advanced `47c5788` → **N8 `4e1bbdd`** → **N1(b) `3fcf357`** → **N9 `7055e93`**.
Suite **654/654 across 120 files**, `tsc --noEmit` clean on merged main (the
`t4_crash_resume` parallel-load flake is intermittent, passes in isolation).
Delivery for non-dept projects is now unblocked end-to-end: N8 makes `gh` run in
the project repo, N9 makes the post-merge `backup.push` run there too. N1(b) closes
the stale-verdict strand. **Details per fix below.** Remaining pre-Phase-8: **N0**
(junior completion race — needs a live run) + **N3** (junior-B bypass —
investigative) are the two concurrency P0s; **N2** (delivery-gate phase filter)
needs a phase-taxonomy decision (`phase` col unstandardized). **N1 option (a)**
(real junior verify-fix dispatch) is deferred behind N0. Small follow-up the senior
noted: `backup_push.ts` could reuse `getTaskRepoRoot` instead of its inline lookup.

**PRE-PHASE-8 N3 FIXED (2026-09-01, merged local main `c4d16fb`, PUSHED to origin):** the
junior-B bypass is closed. **Root cause was simpler than the ledger's hypothesis:**
`assignJunior({taskId})` (deterministic A/B by task id) had **zero production callers** —
the auto-kickoff chain (`fileTask` → `plan.cycle {taskId}` → registry → `runPlanReviewCycle`)
never invoked it, and three flow doors defaulted an unpinned junior to a hardcoded
`(opts.junior || 'A')`. That `|| 'A'` WAS the de-facto policy, so every auto-kickoff task
ran on A (not `JUNIOR_DEFAULT`, which `assignJunior` honors but which was never reached).
Fix: `assignJunior({taskId})` is now the fallback at all three doors — `plan_review_cycle.ts:278`
(propagates into the dispatch payload), `work_review_cycle.ts:396` (REVISE fix dispatch),
`verify/loop.ts:100` (N1(b) stale-approval re-review, pinned explicitly). Deterministic-by-id
means every phase of a task converges on the same junior with **no persisted column**;
explicit pins + `JUNIOR_DEFAULT` still win. New `test/integration/tc_junior_assignment.test.ts`
(6 tests incl. the two-task split regression on the run's own UUIDs — `3756ec6e`→A,
`b55e2fda`→B); mutations **M-N3a/b/c** recorded (`docs/mutation-evidence-phase8.md`).
**claude senior APPROVE** — genuine independent subprocess review (the earlier zai attempt
was a voided phantom-verdict: it self-attached to port 9335 = the working session's own
ZCode; details in `docs/plan-n3-junior-assignment.md` §Senior review). The senior traced
every enqueue site (incl. rekick/reconcile/verify-failure/chained work.cycle), confirmed the
residual `?? 'A'` at `dispatch-job.ts:246` is observability-only not a selection path, and
hand-verified the hash. Verdict `docs/reviews/verdict-n3-junior-assignment.md`. Suite
**660/660 across 121 files green ×2**, `tsc --noEmit` clean on merged main. **Pushed to
origin (`c4d16fb`, origin == local, verified 2026-09-01).** **Candidate N10** logged: `run_senior --senior zai` has no guard against
attaching to a non-senior window on 9335 (the phantom-verdict class) — worth hardening.

**PRE-PHASE-8 N0 FIXED (2026-09-01, merged local main `ed553c3`, two-round claude-senior
review, APPROVE at `0bd049c`):** the junior "completion" race is closed — the LAST P0 gating
concurrent runs. **Live root cause (observed on junior A, `scripts/n0_observe.ts`, logs
`docs/junior-artifacts/n0-observation-run{4,5-gate}.log`):** an agent that ends its TURN while
its own terminal subprocess runs renders NO Stop/Cancel/spinner anywhere in the DOM —
idle+stable alone cannot distinguish "waiting on my test run" from "done" (the b55e2fda ~38s
false completion, reproduced at t=12s with ~85s of subprocess pending). **Fix (evidence-picked
A; C dead — no terminal-busy DOM signal exists):** `waitForAgentIdle` gains
`completionEvidence` + `evidenceTimeoutMs` (5 min): idle+stable completes only when the
`BUREAU-JUNIOR-COMPLETE` sentinel appears in the REPLY REGION; a markerless state fails LOUD;
real activity re-arms the clock. All three department junior prompts carry the instruction;
the driver seam auto-arms the gate from the prompt; sentinel-less CLI prompts unchanged.
**Round 1 was REVISEd** by the senior — it caught the evidence check reading through
`extractAgentReply` (whole-prompt needle → page-tail fallback → the ECHOED prompt could
false-open the gate; the round-1 observation dodged it via a single-line prompt) — fixed with
the line-aware pure `juniorCompletionEvidence` (`sliceAfterPrompt` keys off the prompt's LAST
line), +5 unit tests incl. the demanded just-echoed-multi-line case, sentinel filtered from
artifacts, `requireActivityStart` exemption justified (fast junior replies would false-stall).
Round 2 APPROVE hand-verified the algorithms, re-derived M-N0a/b/c, and confirmed the
agent-quote residual is fail-closed (loud stall, never silent false-open). Verdict
`docs/reviews/verdict-n0-junior-completion.md` (both rounds). **Live round-2 validation: the
shipped gate held ~80s of `awaiting-evidence` through a real subprocess gap on a
department-shaped multi-line prompt and completed only at the true marker (t=126s).** Suite
**668/668 across 121 files** (one adjacent run 667/668 = t30 browser-launch flake under
three-GUI load, next run fully green), `tsc --noEmit` clean. **N0+N3 both landed: the ≥3-task
concurrent run that opens Phase 8 is unblocked.**

**FIRST AUTONOMOUS MULTI-TASK RUN (2026-09-01) — N9/N10/N1a filed through the door, run under
one resident runner with N0+N3 live.** The three remaining pre-Phase-8 fix items were filed as
engine-dev tasks and run concurrently: **N9** (getTaskRepoRoot tidy→junior B), **N10** (zai
window guard→junior A), **N1a** (verify-fix dispatch→junior A). **N1a ran the FULL pipeline
end-to-end to `needs-review`** — plan → junior.dispatch implement → **claude walkthrough
APPROVE** → verify.run **exit 0** (50s) — producing a real **684-insertion** diff
(`engine/verify/loop.ts`+`job.ts` + `tc_verify_fix_dispatch{,_flow}.test.ts` + mutation evidence)
in its worktree. **This is the first fully autonomous end-to-end task completion, and it proved
N0 live** (the dispatch completed only when the agent was genuinely done, not at a ~38s false
idle). **N1a was operator-approved and MERGED to origin/main via PR #6 (`f618ba9`, 2026-09-01)** —
so N1 option (a) is now delivered. Caveat carried on the record: its gate was a `walkthrough`
review, NOT a `phase4` diff review (**N2**), so it merged flow-complete, not diff-verified — a
retroactive diff review is warranted. **N9 and N10 both died during PLAN AUTHORING** ("no
progress for the stall window"; N10 also died first on a cold-start collision) — **rekicked once
more 2026-09-01, stalled AGAIN identically, so both were ARCHIVED** (blocked by the unfixed N13
stall; re-file after N11/N13 land or do as engine-dev). Three new
findings catalogued in `docs/plan-pre-phase8-remaining.md` **§2026-09-01**: **N11** (plan
authoring bypasses the `window-${junior}` lease → same-junior tasks double-launch the IDE and
collide — the operator-observed RAM waste; the real concurrency fix, distinct from N3), **N12**
(`plan.cycle` is `max_attempts:1` → a cold-start attach miss dies terminally, needs operator
rekick — N4 recurring under concurrency), **N13** (2 of 3 authoring runs hit the 120s stall net
— investigate whether that window is too tight for engine-dev planning). Process notes: a resident
runner (`5ecfb91d`) was already draining — a second runner was mistakenly started on top of it
(competing-runner double-launch) and then stopped; and a **serial rekick** of the two dead
same-junior tasks succeeded (hold the second until the first frees the junior). N9+N10 were
**rekicked again** (different juniors B/A, safe concurrent) at run's end.

**PRE-PHASE-8 N13 FIXED (2026-09-01, merged origin/main `d8e2954`, PUSHED):** plan authoring is
unblocked. **The root cause was NOT the stall net / too-tight 120s — it was the N0 completion
sentinel applied to authoring.** `buildJuniorPlanPrompt` appended `JUNIOR_COMPLETION_INSTRUCTION`,
arming the N0 evidence gate for authoring; a real folder-set authoring (junior A, Gemini 3.7 Flash
Medium, live-observed) explores the codebase for minutes then writes a plan, and when it finished
WITHOUT echoing the exact `BUREAU-JUNIOR-COMPLETE` line, the **5-min evidence timeout** (not the
120s stall net) reaped it and DISCARDED the plan → the "no progress" deaths of N9/N10/N11.
Intermittent (marker emission is LLM-nondeterministic; 3 controlled obs completed, the stall
itself was not directly reproduced — mechanistic + circumstantial, disclosed to the senior). Fix:
authoring no longer appends the sentinel → gate disarmed for authoring (idle+stable, proven pre-N0);
sentinel stays on implementation + fix prompts. Test inverted, mutation M-N13, suite 676/676 ×2,
tsc clean. **claude senior APPROVE** (`docs/reviews/verdict-n13-plan-authoring-stall.md`) — verified
scoping, weighed the residual truncation risk as acceptable (revert-to-proven + rubric backstop),
offered **N14** follow-up (on evidence-timeout, salvage the captured plan instead of discarding).

**N13 VALIDATED LIVE + END-OF-DAY SIGN-OFF (2026-09-01, origin/main `3171b19`).** N11
(`0e921cfa`) was re-filed on the fixed code to validate N13: **plan authoring WORKED** — it
authored across two rounds with NO stall (vs the pre-fix ~10.5-min death), got APPROVED, and the
junior IMPLEMENTED a real 349-line change. So the N13 fix is proven end-to-end. **But the fix flow
then exposed two new problems (both filed as findings):** **N15** — the post-fix re-review
`work.cycle` DIED on *"Claude CLI senior stalled: no output for 300s"* (the claude senior was being
driven manually for reviews at the same time the runner called it — contention; single-attempt →
terminal). **N16** — N11's junior work LEAKED into the **primary checkout** (uncommitted engine
edits, the N7 scar with real engine code); it was **stashed off main** so `main` stays clean at
`3171b19`. N11 is left stuck at `claimed` (its work lives in its worktree). Also noted: the fix
prompt's "revision round 2" labeling reads as if round 1 vanished (the round-1 review is done by
the senior off-window) — cosmetic, relabel. **Tree is clean and green; origin == local `3171b19`;
nothing unreviewed was pushed.** Signing off for the day here.

**PRE-PHASE-8 SESSION (2026-09-02) — ntfy-on-filing feature landed + N15 filed and in flight.**
Operator request: "every time a task is filed, update the dept to send my ntfy; ensure it is
updated in the settings as well." Shipped as engine-dev on `wt/ntfy-task-filed` (merged `--no-ff`
`5334ab9`, claude senior APPROVE, verdict `docs/reviews/verdict-ntfy-task-filed.md`, PUSHED):
new catalog event `task.filed` (`taskState: 'queued'`) — the catalog lights up the trigger
(`NOTIFYING_TASK_STATES`) and the console Settings list together, so they cannot drift;
`fileTask` fires the push after the filing transaction commits (mirroring machine.ts's
transition hook), only on the fresh-insert path (idempotent re-file does not duplicate); no
production code transitions INTO `queued` (the filing INSERT is the only entry), so behavior
change is exactly "filing pushes". Suite 677/677, mutations M-NTFYF-1 (firing site) / M-NTFYF-2
(catalog gate, 3 catchers). **Then N15 was filed through the agent door (task `1ac387ee`,
agent glm) — the filing itself live-proved the feature: the QUEUED push arrived on the topic
(delivered to the operator's phone).** But the push's journal span was MISSING: the
`task:file` CLI's `finally { db.close() }` won the race against the fire-and-forget
notification (push delivered, record lost). Fixed same-session on `wt/ntfy-filing-span-drain`
(merged `--no-ff` `a60ee47`, PUSHED): `file_task.ts` tracks the in-flight push,
`drainFilingNotifications()` polls it to empty, and BOTH CLI doors await it before closing —
the senior's round-1 REVISE caught that `scripts/intake.ts`'s default conversational path
(officer `file_task` inside a drained `intake.turn`) was also exposed; round 2 APPROVE
(verdict `docs/reviews/verdict-ntfy-filing-span-drain.md`). Mutation M-NTFYF-3b (an initially
inert mutation — the while-loop re-polls the set — is disclosed in the evidence file).
Suite 679/679 ×2 on merged main, tsc clean. Meanwhile the resident console/runner came online
and **N15 ran healthy through the fixed pipeline: 3 plan-review rounds (no stall — N13
holding), plan APPROVED, `claimed`, `junior.dispatch` running** (junior implementing in its
worktree). Known flake `t38` failed once under full-suite parallel load, passed in isolation
and in every later full run. `b55e2fda` (window-lease heartbeat) shows done — approved+merged
by the operator since EOD.

**➜ NEXT INSTANCE — START HERE (as of 2026-09-02, origin/main `a60ee47`):** the tree is green
(679/679 ×2, tsc clean), main checkout clean. **NEW this session (all merged + PUSHED):** the
operator's standing request is a feature now — **every filed task pushes an ntfy notification**
("Task filed", inbox_tray/memo, default priority). Catalog entry `task.filed` (`taskState:
'queued'`) is the single source of truth for trigger + Settings list (auto-updated, no console
change needed); `fileTask` fires it post-commit, idempotent re-file doesn't duplicate
(`5334ab9`, senior APPROVE `docs/reviews/verdict-ntfy-task-filed.md`). **Live-proven on the
very next act:** filing **N15** through the agent door pushed to the phone (confirmed on the
topic cache). Follow-up fix landed same session (`a60ee47`, senior REVISE→APPROVE
`docs/reviews/verdict-ntfy-filing-span-drain.md`): the CLI doors now `drainFilingNotifications()`
before `db.close()` — the fire-and-forget push raced CLI shutdown and lost its journal span
(push delivered, record vanished; the senior's round-1 REVISE caught the officer-driven
`intake.turn` path too). Mutations M-NTFYF-1/2/3b in `docs/mutation-evidence-phase8.md`.
**N15 (`1ac387ee`) is IN FLIGHT and healthy:** authored across 3 plan rounds with NO stall
(N13 holding), plan APPROVED, task `claimed`, `junior.dispatch` RUNNING (junior implementing
in its worktree — N0 completion gate live). Punch list
(`docs/plan-pre-phase8-remaining.md`), priority after N15 lands: **(1) N16** — junior work
leaked into the primary checkout (scope the dispatch window to the worktree + verify primary
stays clean; also re-check the delivery-branch model). **(2) N11** — recover the stuck task
OR do the window-lease serialization as engine-dev; **still the remaining concurrency P0**
(until it lands, run ONE task at a time). **(3) N12** cold-start retry, **(4) N2**
delivery-gate phase filter, **(5) N9/N10** re-file (their plan.cycle jobs are dead — operator
rekick needed), **(6) N14** salvage-plan-on-timeout. Then supervised provisioning convergence
+ the **≥3-task concurrent run = Phase 8 proper**. Operator-only: retroactive diff-review of
merged N1a, approve `3756ec6e` (still needs-review; `b55e2fda` was approved+merged since
EOD), decide N6, archive orphan `live-mt0xgoxz`. Runtime notes: a console+runner is live
(online push 2026-09-02, runner claimed N15's cycle); juniors were cold at session start and
auto-launched fine; `t38` flaked once under parallel load then passed in isolation and in
both subsequent full-suite runs (the known browser-launch flake class).

**CREATORS PAGE (2026-08-31, non-engineering keepsake).** At the operator's request,
a "Record of Hands" creators page was built — every persona (Claude Code, the Claude
senior, GLM/zai, Gemini/Junior A, Antigravity 2.0/Junior B) was reached live over its
debug port and wrote a genuine signed message; nothing fabricated. Published as a
private Artifact (`The Record of Hands`). It was driven with a throwaway script
(since removed) that reused the existing junior/senior harnesses (`ensureJuniorRunning`
+ `AntigravitySession`, `ensureSeniorRunning` + `ZCodeSession`) to send each agent a
prompt and capture its reply — a reminder that the harness can drive the agents for
free-form chat, not only tasks. Not part of the engine — noted only so it's on record.

**PRE-PHASE-8 N8 FIXED + N9 FILED (2026-08-31, merged local main `4e1bbdd`):** the
first pre-Phase-8 code fix landed. **N8** — `pr.create`/`pr.merge` ran `gh` in the
dept repo for non-dept projects (proven 2026-08-31: every non-dept delivery died
"No commits between main and bureau-wt-…") — is fixed: the `PrProvider`
`createPr`/`mergePr` seam gained an optional `cwd`, `GhCliPrProvider` forwards it
(defaulting `this.repoRoot`), `pr_create.ts` threads `wtRow?.path` into `createPr`
(mirroring the existing `pushBranch`) and `pr_merge.ts` looks up the worktree
(present pre-prune) and threads it into `mergePr`. `FakePrProvider` records the cwds;
t43/t44 assert the worktree path flows through create AND merge; mutation **M-N8**
recorded (`docs/mutation-evidence-phase8.md`). Suite **646/646 across 117 files**,
`tsc --noEmit` clean on the branch and on merged main (one intermittent parallel-load
flake on unrelated `t41` seen once, cleared on re-run — the standing `fileParallelism`
debt, not N8). **claude senior APPROVE** by close code-read of the branch
(`docs/reviews/verdict-n8-pr-gh-cwd.md`), merged `--no-ff` to local main `4e1bbdd`
(**not pushed** — origin push is the operator's call). During that review the senior
surfaced **N9** (new P0): `backup.push` (enqueued after every merge, non-dept
included) always runs in the dept repo via `git_backup_provider.ts`/`backup_push.ts`
with no cwd threading — the same class of bug one layer down, so the post-merge backup
containment-check reads the dept remote, not the project's. N9 is catalogued in
`docs/plan-pre-phase8-remaining.md`.

**PRE-PHASE-8 N1(b) FIXED (2026-08-31, merged local main `3fcf357`):** the
stale-verdict delivery hole is closed. On verify SUCCESS, `handleVerifyOutcome` now
refuses to reach `needs-review` when the latest approved work review's
`reviewed_commit != tip` (a `verify-failure-sendback` moved the tip past the approval
— the b55e2fda scar): it transitions `verifying -> claimed`, enqueues `work.cycle` to
re-review at the new tip (idempotent), journals a `verify_passed_stale_approval`
guardrail, and notifies the operator. `tip` is read in `verify/job.ts` before the
finalization txn (best-effort; undefined disables the guard, so fake-provider tests
are unaffected). The retry/block budget (t25/t29 exit-sentence loop) is deliberately
untouched. **The claude senior REVISED round 1** — it caught a real self-match bug
(the idempotency guard checked `verify.run`, which self-matched the current job inside
its own txn, so `work.cycle` was never enqueued and the task stranded at `claimed`) —
fixed by narrowing the check to `work.cycle` only, plus a new integration test through
`executeVerifyRunJob`; **round 2 APPROVE** (`docs/reviews/verdict-n1-verify-stale-
approval.md`). Mutations M-N1/M-N1b. Suite **652/652 across 119 files** green on the
branch and on merged main (the documented `t4_crash_resume` parallel-load flake
appeared once, passes in isolation), `tsc --noEmit` clean; merged `--no-ff` to local
main `3fcf357` (**not pushed**). **Option (a)** (real junior verify-fix dispatch) is
deferred behind **N0**. **Next per the punch list:** N3 (junior-B bypass,
investigative) / N0 (junior completion race, needs live verification) — both P0 for
concurrency — then N2 (delivery-gate phase filter) and N9.

**FIRST 2-CONCURRENT RUN + OPERATOR FIX (2026-08-30/31):** the department ran two
department-filed tasks with overlapping wall-clock (~18:54–19:19) — `3756ec6e`
("hello marker", Trading repo) and `b55e2fda` ("window-lease heartbeat" = the P1.2
fix, this repo). Both reached `needs-review`. **The run proved seniors parallelize
(claude + zai concurrently) but juniors do NOT yet:** both tasks were dispatched to
**junior A** on the shared `window-default` lease (the deterministic `assignJunior`
hash would have put b55e2fda on **B**), so they were time-sliced on one window/chat
and **cross-contaminated** — transcripts, plan artifacts, and even the hello task's
implementation prompt (which embedded the heartbeat plan's "SENIOR'S FINAL REQUIRED
CHANGES") were crossed. The claude senior's own round-2 review caught the
contamination; 3 of its 4 rounds on `3756` were fallout. **Operator fix this session:**
`b55e2fda` was delivery-blocked — its only gating `bureau_work_reviews` row was a
`phase='walkthrough'` review at `9186a05`, but the branch had advanced to `c126a68`
via a `verify-failure-sendback` checkpoint (test-only fixes: removed a nonexistent
`bureau_meta.updated_at` column + fixed a floating promise), so `pr.create` would have
refused (`reviewed_commit != tip`). A genuine **phase4 code-diff** senior review was
recorded at the tip (Claude Opus 4.8; full suite **646/117 green** at `c126a68`;
verdict `docs/reviews/verdict-b55e-heartbeat-tip.md`). `3756ec6e` needed no fix
(tip==reviewed `86cccba`, clean, `hello.txt`="hello trading"). Both now pass every
`pr.create` precondition — **approve-ready in the console.** The root causes (junior
"completion" firing at ~38s while the agent had only started its baseline test run and
then kept editing through review/verify; the verify-sendback advancing the tip past the
approved commit with no re-review; the junior-B bypass) are catalogued as **N0–N7** in
`docs/plan-pre-phase8-remaining.md` — **concurrency is NOT proven; N0 + N3 must land
before any ≥3-task run.** Process debt on the record: the five evening stream merges +
the zai-capture fix (`4d04abf`…`7163e72`) reached origin/main with **no posted verdict
docs** and zero journal spans in the merge window (N6) — ratify-or-retro-document is an
operator call.

**SELF-DRIVING PROVEN + PHASE-8 ENTRY GATE CLEARED (2026-08-28, origin/main
`40e4157`, 582/582 + build clean):** the department ran two real tasks the FULL
flow with zero hand-repairs — filed through the agent door → auto-kickoff →
junior (Antigravity/**Gemini 3.7 Flash Medium**) authors plan → **claude** senior
reviews → junior implements in the bureau worktree → claude walkthrough review →
staged `verify.run` exit 0 → `needs-review`. Both delivery-ready (`reviewed_commit`
== branch tip), awaiting operator approval. Getting here took three harness fixes,
all merged + pushed this session: (1) **ZCode capture-race fix** (`be7abc5`,
`requireActivityStart` in `waitForAgentIdle`) — the zai senior was abandoning
reviews at ~9s in the submit→generation gap and orphaning verdicts; claude senior
APPROVE, verdict `docs/reviews/verdict-zcode-senior-capture.md`. (2) **Department
resilience** (`e4a56e8`), implemented by **zai (ZCode/GLM)** and reviewed by the
claude senior (APPROVE, `docs/reviews/verdict-dept-resilience.md`): WS1
`ensureSeniorRunning` + `runSeniorWithRecovery` (auto-relaunch a downed ZCode
senior, one mid-death retry, fail-closed on home-screen/stall), WS2
`recoverJuniorRunning` + wedged-window retry in `junior.dispatch` (auto-recover a
downed/wedged Antigravity junior in-flight — **proven live**: Antigravity was down
and the flow auto-launched it), WS3 `makeInactivityGuard` (adaptive claude timeout
— stall window + absolute cap, no more hard 20-min kill), WS4 retightened
`SENIOR_HOME_SCREEN_MARKERS` + a single-ZCode-instance mutex (`zcode-lock.ts`).
(3) The Stream B provisioning console (task `1429a7de`) was approved + merged as
**PR #2** while these landed; local/origin had diverged (local had the harness
fixes, origin had PR #2) and were **reconciled** (`40e4157`, clean/disjoint files),
then pushed. Verification of the two self-driven tasks (operator skepticism about
Gemini): both transcripts confirm genuine **Gemini 3.7 Flash Medium** sessions
doing real edits + real test runs — smooth because the tasks were tiny + hyper-
specced and the **claude senior reviewed the real worktree code** (task 1 shipped
no `walkthrough.md` at all; approval was grounded in the actual diff), NOT because
Gemini reformed. The honest next test is a genuinely hard task. Roadmap for what
remains: `docs/plan-pre-phase8-remaining.md` (P0 convergence run, P1 concurrency
readiness, P2 debt). zai/GLM account hit its 5-hour quota this session → reviews
pinned to claude via `SENIOR_DEFAULT`.

**FIRST FULLY-TRACKED DELIVERY — project provisioning engine shipped end-to-end
(2026-08-26, merged PR #1 = `d34baa0`, local main suite 488/488, build
clean):** task `6490336d` ("Implement self-serve project provisioning with
job-driven workflow") traveled the ENTIRE tracked path for the first time —
live Gemini intake officer drafts + human confirm-verify gate → auto-kickoff →
6 plan-review rounds (junior A authoring in Antigravity, claude senior
reviewing; ceiling auto-proceeded to implementation) → junior implemented
Stream A IN a bureau worktree → work-review loop (REVISE round 2 caught the
junior's dead `if (false as boolean)` actor guard — the fake-guard pattern —
independently of the operator's review) → junior IDE closed for PC load;
operator-side session secured the WIP verbatim (`1918ce1`), applied the fix
round (`7e25e53`: real allowlist, `D:\projects` default, registerProject
routing), executed mutation evidence M-PROV-1..4 (+ strengthened T-PROV-4 with
a `repoPrefix:'../evil/'` vector — the only input containment uniquely
catches) → senior APPROVE round 4/5 (verdict
`docs/reviews/verdict-project-provisioning.md`, reviewId `f57bc99f`) →
`verify.run` exit 0 on the worktree branch → `needs-review` → operator
Approve (console) → `pr.create` + `pr.merge` → **task `done`**, PR
`https://github.com/departmentofcoding-wq/department-of-codeV2/pull/1`,
local main fast-forwarded. Delivered: `engine/projects/provision.ts` +
`repo_provider.ts` (gh-CLI seam) + `config.ts` (meta: projects_root
`D:\projects` / repo_prefix `dept-` / github_owner), schema columns, span/job
kinds, deterministic job id, CLI `project create`; 9 T-PROV tests. Plan doc:
`docs/plan-project-provisioning.md` (untracked, operator-confirmed decisions).
Live-drill scars, all journaled repairs: `reviewed_commit` left null when the
cycle runs without the runner's workspace-provider wiring (pr.create refused
correctly; repaired via the engine's own checkpoint+tip steps); NO runtime
PrProvider registration anywhere (drained inline by the operator; see
follow-ups); junior's house-convention branch vs the `bureau-wt-` delivery
branch diverged (fast-forwarded, linear, no rewrite); two senior reviews died
at the 180s default claude timeout (two-runner claim lottery); Antigravity
loses its CDP port on relaunch without the debug flag (kill + clean relaunch
is the recovery); the intake CLI adopted an old open session instead of a
fresh one.

**Part-A improvements sprint — A1–A5 all merged to local main (2026-08-26):**
Executed Part A of `docs/plan-bureau-kernel-roadmap.md` end-to-end. Each stream
was built on its own `wt/*` branch (green suite + `tsc --noEmit`, mutation-proven
where it had a code guard), **senior-reviewed by the Claude CLI senior** (driven
headless via `claude -p`; ZCode/zai was offline this session), REVISE rounds
fixed live, and merged `--no-ff`.

- **A1 — merge-law enforcement + delivery-tail lock** (`c92e2ed`, verdict
  `docs/reviews/verdict-a1.md`): `engine/delivery/merge_guard.ts` predicate +
  git hooks (`scripts/merge_guard_hook.ts`, `scripts/install_git_hooks.ts`,
  `npm run hooks:install`) — pre-merge-commit/pre-commit **and** a
  `reference-transaction` hook that closes the fast-forward bypass the senior
  caught; `t45` locks the seam-joined tail (walkthrough APPROVE → drain → done).
  Live-proven refusal + operator override. **Hooks intentionally NOT installed
  in-repo** (would block engine-development merges).
- **A2 — Phase-7 leftovers** (`9c35957`, `verdict-a2.md`): model-id attribution
  fix (`ollama/qwen2.5-coder`→`qwen2.5-coder` + boot-door `normalizeModelIds`
  heal), mutation-proven budget refusal (token + request), `t46` backup vs a
  real bare remote.
- **A3 — multi-tier verification**: D0 freeze (`a467485`, `verdict-a3-d0.md`) —
  `VERIFY_STAGES` + nullable columns; impl (`ea6ef10`, `verdict-a3-impl.md`) —
  staged `verify.run` (structural → fail-to-pass → pass-to-pass), aggregate exit
  0 iff every non-skipped stage passes; back-compat with the single `verify_cmd`.
- **A4 — test determinism** (`dc23acc`, `verdict-a4.md`): retired
  `fileParallelism:false`; wall-clock condition loops in t4/t6/t14/t28 → `pollUntil`;
  t36 explicit timeout. Suite green under full parallelism, ~2.4× faster.
- **A5 — cost accounting** (this stream): per-model pricing (meta-updatable),
  rollup computes dollars from tokens × price, honesty preserved (unpriced spend
  is a FLOOR, never $0), `getPeriodCostRollup` + `npm run cost:report`.

Method note: the senior was driven with a "headless — review statically" note
(the `claude -p` sandbox can't run the suite); it verified by close code reading.
Merges are on **local main only (not pushed)** except where a session pushes.
Next phases planned in `docs/phase-8-plan.md` / `-9-` / `-10-`.

**ZCode 3.8.1 senior harness recalibrated — GLM senior drives again (2026-08-26,
merged `e8f8097`):** the zai/GLM senior broke when ZCode upgraded to 3.8.1
(`run_senior --senior zai` failed at submit). Two calibration drifts, both
diagnosed live over CDP and fixed in `engine/harness/senior.ts` `ZCodeSession`:
(1) **submit** — the composer is a multiline rich-text editor (Enter = newline, and
it never clears the contenteditable DOM on send), so the old "press Enter then
check the box emptied" mis-fired both ways; now clicks the real control
`button[data-testid="v4-composer-send"]` and confirms via the Send button
re-disabling / a Stop control appearing (never DOM text). (2) **completion** —
`probeActivity`'s `canSend` was gated by an `onHomeScreen` heuristic keyed on
markers ("Add context"/"Full access"/"Plan mode") that are NORMAL composer controls
in 3.8.1, so `canSend` was always false and every finished review read as a
**stall**; now `working = [data-testid="v4-stop"]`, `canSend = [data-testid=
"v4-composer-send"] present && !working`. Pure functions
(`buildReviewPrompt`/`parseVerdict`/`detectUncapturedReview`) untouched;
`SENIOR_HOME_SCREEN_MARKERS` retained for `detectUncapturedReview`. **Proven live
end-to-end:** post-fix, `run_senior --senior zai` COMPLETED — GLM worked 8m33s and
returned `VERDICT: APPROVE` (re-ran suite twice + build) on the prior console
branch. This branch itself reviewed by the **claude** senior (APPROVE, independent
of ZCode to avoid circularity; verdict `docs/reviews/verdict-zcode-send-
recalibration.md`) + operator-verified. Suite 435/435, build clean on merged
`main` (`--no-ff`). Scar: GUI selectors are version-fragile — prefer stable
`data-testid`s over label heuristics; never treat a contenteditable's DOM text as a
submit signal.

**Console Projects tab + mobile-responsive UI + ntfy expansion (2026-08-25, merged
`e9a1b7f`):** two operator-requested console features shipped through the review
loop. (1) **Projects tab** — the multi-repo engine (`bureau_projects`,
`registerProject`/`listProjects`) was CLI-only; now `GET`/`POST /api/projects`
(reusing the engine helper unchanged, so the on-disk git-repo gate + `.bureau-
worktrees/` gitignore + `project-registered` span stay intact) back a Projects nav
tab (view) + Add-Project modal (name, folder path, description). `ENDPOINTS` 27→29.
(2) **Mobile-responsive** — `styles.css` had a viewport tag but ZERO `@media`
queries; added 768/480px breakpoints (header stacks, nav scrolls, tables scroll in
their card, modals full-width), verified live at 375px with zero horizontal
overflow. (3) **ntfy expansion** — the notify trigger moved from hardcoded
`blocked||done` to `NOTIFYING_TASK_STATES.has(toState)` from a new
`engine/notifications/events.ts` catalog, so **needs-review** (the phone-approval
gate), **claimed** (task started), and **failed** now push too; added
`notifyDepartmentOnline` (console startup), a generic `NtfyClient.sendMessage`, a
`POST /api/settings/ntfy/test` endpoint + Settings "Send test" button, and a
Settings list of what sends notifications (from the catalog). `ENDPOINTS` 29→30.
Journal hygiene unchanged (spans record success + `topicConfigured`, never the
topic). **Review path:** zai (ZCode GLM) senior attempted FIRST but failed loudly
on a Send-selector mismatch (ZCode 3.8.1 > 9335 calibration) — phantom-verdict
guard refused to fabricate; the **claude CLI senior then reviewed the diff directly
and returned APPROVE** (no discrepancies; verdict
`docs/reviews/verdict-console-projects-mobile-ntfy.md`, walkthrough alongside).
Operator re-verified the two claims the senior's sandbox couldn't run. Suite
**435/435 across 94 files**, build clean on merged `main` (`--no-ff` merge commit).
**Follow-up:** recalibrate the ZCode Send selector in `engine/harness/senior.ts`
for the 3.8.x GUI so the GLM senior drives again.

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
