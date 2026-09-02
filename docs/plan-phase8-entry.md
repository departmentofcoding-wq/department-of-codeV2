# Plan — Drill-Scar Fixes + Supervised Provisioning (the Phase 8 entry gate)

Status: **authored 2026-08-26 (late), fresh execution begins 2026-08-27.** Cut from
`main` = `d34baa0` (merge of PR #1 — the department's **first fully-tracked
delivery**). Suite **488/488 across 102 files + build clean, re-verified this
session**; live-DB claims independently confirmed (task `6490336d` `done`,
`merged_at` set, `verify.run`/`pr.create`/`pr.merge` job rows present, approve
review `f57bc99f` carries `reviewed_commit = dac626d…`). Like
`docs/plan-project-provisioning.md`, this file is deliberately untracked —
committing it is the operator's decision, through the flow.

## Why this comes before Phase 8

The 2026-08-26 drill proved the tracked path end-to-end — but the delivery tail
(`pr.create`/`pr.merge`) needed **three operator-side repairs** to finish, and
two live senior reviews died at a 180s timeout. Phase 8 runs **N tasks
concurrently**: every scar below multiplies by N, and an operator who must
hand-repair every merge cannot supervise scale. So the order is:

1. Close the drill scars (the fix pack below) — and prove them live by shipping
   the fix pack **through the machinery it fixes**.
2. Finish provisioning Stream B (the console half of the shipped engine).
3. Run the supervised provisioning convergence (the original request, proven).
4. *Then* enter Phase 8 (`docs/phase-8-plan.md`) with a tail that drains itself.

## The scars (all root-caused to file:line this session)

| # | Scar (what happened live) | Root cause (verified) | Fix |
|---|---|---|---|
| S1 | `pr.create` refused ×3 ("work review commit (null) does not match branch tip"), job `dead` | `engine/flow/work_review_cycle.ts:290-296` — `reviewed_commit` recorded only inside `if (wsProvider)`; direct (non-Runner) invocation skipped it silently, row stays NULL (`:255-256`) | **F2** |
| S2 | Even after repair: "PR provider has not been initialized or registered" — no runtime path registers a `PrProvider` | `engine/contract/pr-seam.ts:5-14` fail-closed getter; `setPrProviderOverride` called **only in tests**; Runner wires `setWorkspaceProvider` (`runner/main.ts:113`) but not the PR seam; `scripts/console.ts` wires nothing (inherits Runner) | **F1** |
| S3 | PR opened against `bureau-wt-<taskId>` still at base — "No commits between main and…" | Two-sided contradiction: worktree is created on `bureau-wt-<taskId>` (`engine/worktrees/manager.ts:219,227`) and `pr_create.ts:103-105` pushes that branch — but the junior's own plan prompt **mandates** `wt/…` branch naming (`engine/flow/plan_review_cycle.ts:129,189`), so the junior commits on a different branch inside the worktree | **F3** |
| S4 | Two live claude senior reviews hard-killed mid-review | `engine/harness/senior.ts:324-327` — default `CLAUDE_SENIOR_TIMEOUT_MS` = 180000; tonight's successful review needed 600000 (env-set manually) | **F4** |
| S5 | Intake CLI grafted a new request onto an old still-open session | `scripts/intake.ts:45-59` — adopts newest open session by default; fresh only when none open | **F5** |
| S6 | Antigravity loses its CDP port on relaunch (junior dispatch stalls) | IDE relaunch without `--remote-debugging-port`; ops matter, not code | runbook note (below) |
| S7 | Junior shipped a dead actor guard (`if (false as boolean)`) | The recurring fake-guard pattern; caught by REVISE round 2 + operator review — the loop worked | none (process held); watch for it every round |
| S8 | Plan-review round 3 burned on conversational (non-rubric) junior replies | plan prompt asks for a rubric but doesn't enforce a format | **F6** |

Housekeeping scar: ledger, plan docs, verdict, and the `6490336d` junior
artifacts are still **untracked/uncommitted in main's tree** — the tree is not
clean, which blocks the Phase-8 bootstrap. Step 0 below.

## Independent verification addenda (2026-08-26, second review)

A second session re-verified every scar root cause above against source
(all confirmed true) and the suite (488/488 × 102 files, exit 0 on `d34baa0`).
Four corrections/additions to fold in:

- **A1 — convergence is decoupled from the fix pack AND from Stream B.** The
  provisioning `RepoProvider` seam is **not** symmetric with the PR seam:
  `getRepoProvider()` (`engine/projects/repo_provider.ts:68-72`) **live-defaults
  to `GhCliRepoProvider`** when no override is set, and the CLI path
  (`scripts/project.ts` → `enqueueJobIfAbsent` → `drainSingleJob`) needs neither
  F1 (the PR seam) nor the Stream B console UX. **Consequence:** the supervised
  convergence run can — and should — happen **early**, right after bootstrap, as
  the day's first proof (it's the item the operator explicitly wants before
  Phase 8, and it has the fewest dependencies). If a live-network scar hides in
  provisioning, better to surface it before building the fix pack on top. Stream
  B then only adds the *console* entry to an already-proven engine. See the
  reordered operations below.
- **A2 — F1 note is stale:** `getPrProviderOverride` is **already exported**
  (`pr-seam.ts:16-18`); F1 is pure wiring, nothing to export.
- **A3 — F3 must touch BOTH prompts:** the more direct culprit is
  `buildImplementationPrompt` (`plan_review_cycle.ts:189`, "work on the branch
  named in the plan"), not only `buildJuniorPlanPrompt` (`:129`). The junior
  reads the *implementation* prompt when it actually commits. Fix both.
- **A4 — the seam asymmetry is intentional, keep it:** F1 keeps the PR seam
  fail-closed while the repo seam live-defaults. That divergence is deliberate
  (provisioning is CLI-operator-initiated and network-by-design; PR delivery
  must refuse an unwired seam rather than silently `gh`-merge). Document it in
  F1 rather than "fixing" it — do not add a live default to `getPrProvider()`.

## Fix pack — Stream A (`wt/junior-a-delivery-tail`)

One stream, five small fixes; every fix ships with a regression test, and F2/F3
carry mutation evidence (they are guards). The stream is deliberately delivered
**through the live machinery** (intake → junior in the worktree → senior review
→ verify → approve → pr.create → pr.merge): if its own merge drains with zero
operator repair, the fixes are proven live, not just green.

### F1 — wire the PR provider at boot

In the Runner constructor (next to `setWorkspaceProvider`,
`runner/main.ts:113`): `if (!getPrProviderOverride())
setPrProviderOverride(new GhCliPrProvider())` (export the override-getter if
absent). Both entrypoints inherit it — the console constructs a Runner
(`scripts/console.ts:103`). Keep the getter fail-closed (unregistered seam
still throws) — the fix is wiring, not weakening. Considered and rejected: a
live-default fallback in `getPrProvider()` (the `RepoProvider` pattern,
`engine/projects/repo_provider.ts:68-72`) — it would diverge from the
fail-closed seam law that caught nothing tonight but has caught fakes before.

Test: after Runner construction (temp DB), `getPrProvider()` resolves and a
`pr.create` drain reaches the provider (fake) instead of throwing
"not been initialized". No network — fake provider override still wins over
the wired real one (assert override precedence).

### F2 — `reviewed_commit` recorded whenever a worktree exists

`work_review_cycle.ts`: drop the `if (wsProvider)` gate around the tip
recording. On APPROVE, if a `bureau_worktrees` row exists for the task, record
`reviewed_commit = getBranchTipCommit(...)` (it reads the worktree path from
the DB — provider-free) or **fail the approve step loudly** (guardrail span +
non-zero job exit), never silently leave NULL. Checkpoint stays best-effort
via the provider when present. If no worktree row exists at all (legacy
own-workspace juniors), keep a `guardrail` span noting why — visible, not
silent.

Tests: approve with a real temp-repo worktree (no provider override installed)
→ `reviewed_commit` set. Mutation **M-TAIL-1**: restore the provider-conditional
→ test fails (this is exactly tonight's incident).

### F3 — one branch model, enforced both sides

- **Prompt side (BOTH prompts)**: `buildJuniorPlanPrompt` (`:129`, drop the
  "branch name in the form wt/..." requirement) **and** `buildImplementationPrompt`
  (`:189`, the "work on the branch named in the plan" rule the junior actually
  reads when it commits). New rule in both: "work directly on the branch already
  checked out in the worktree (`bureau-wt-<taskId>`); do not create, switch, or
  rename branches."
- **Machinery side (fail-safe)**: `pr_create.ts` resolves the worktree's
  **actual checked-out branch/HEAD** and pushes that tip to the remote ref
  `bureau-wt-<taskId>` (refspec `HEAD:refs/heads/bureau-wt-<taskId>` through
  the provider), so the remote branch is task-correlated regardless of what
  the junior did locally. The reviewed-commit-equals-tip guard already checks
  the commit, not the branch name — keep it that way.

Tests: temp repo + worktree with a foreign branch checked out and commits on
it → `pr.create` (fake provider) pushes the reviewed tip under the
`bureau-wt-<taskId>` remote ref. Mutation **M-TAIL-2**: revert to pushing the
literal branch name → test fails (tonight's empty-PR incident).

### F4 — raise the claude senior timeout default

`engine/harness/senior.ts:327`: `180000` → `600000` (10 min; tonight's live
review ran ~8.5 min at exactly this ceiling, env-set). Env override unchanged.
Test: default resolution when `CLAUDE_SENIOR_TIMEOUT_MS` unset; env still
wins.

### F5 — intake CLI: fresh session by default

`scripts/intake.ts:45-59`: create a fresh session unless `--session <id>` is
passed (adopting an open session becomes explicit — `--continue` for newest
open). Tests: two consecutive no-flag invocations → two sessions;
`--continue` adopts the open one.

### F6 — junior plan format enforcement

`buildJuniorPlanPrompt`: require the plan in a marked, structured format
(sections with explicit headers the existing `PLAN_MARKERS` already look for)
and say conversational replies will be asked to re-emit. Soft change, no law.
Test: prompt-content unit assertion only.

### Runbook addendum (S6, doc-only)

Add to `docs/antigravity-integration.md`: on junior-dispatch stall, suspect a
relaunched IDE without the debug port — recovery is kill all Antigravity
processes + relaunch with `--remote-debugging-port` (the calibrated path).

## Stream B — provisioning console (`wt/junior-b-provisioning-console`)

Exactly per `docs/plan-project-provisioning.md` §4 (the plan doc is merged
content-wise via PR #1's engine half; this is its console half): Add-Project
modal "Create new" mode → `POST /api/projects/provision` → `202 { jobId }`
with a provisioning chip polling job state; Settings gains the projects-root
field + GitHub connection card (`GET /api/settings/github`, masked shape).
`ENDPOINTS` 30 → 32, `contract_d0_c` updated in the same freeze. API tests
against fakes (tc7-style) — no network, the law.

## Convergence — the supervised provisioning run (operator, ~15 min)

The moment the original request is fully proven. Runs via the CLI with only
`gh auth status` green — **no dependency on the fix pack or Stream B** (addendum
A1); do it first (operator priority). The console "Create new" path is later
re-proven once Stream B lands.

1. `npm run project create -- --name scratch-<date> --description
   "supervised convergence run" --actor human-operator` (private by default).
2. Watch the job drain (console or CLI). Then verify ALL of: folder
   `D:\projects\dept-scratch-<date>` with git repo + initial commit; private
   GitHub repo in `departmentofcoding-wq` with the commit pushed;
   `bureau_projects` row with `github_url`; `project-provisioned` span with
   attribution.
3. Teardown: `gh repo delete` + remove the folder. **Known gap to record (not
   fix tonight):** there is no `unregisterProject` — the DB row removal is a
   journaled operator act; file "project deprovision" as a follow-up task if
   the row's survival bothers the books.
4. Ledger entry with the receipts (paths, URL, span ids).

## Order of operations — tomorrow (2026-08-27, fresh windows)

1. **Bootstrap** (every window): read `docs/DEPARTMENT_STATUS.md` → this plan
   → `git log --oneline -10` + `git status` → `npx vitest run` + `npm run
   build`. (Verified green tonight at `d34baa0`; re-run — the house rule.)
2. **Operator decision — commit the docs** so the tree is clean: ledger edit,
   `blueprint-context.md`, `plan-bureau-kernel-roadmap.md`,
   `plan-project-provisioning.md`, `verdict-project-provisioning.md`, the
   `6490336d` junior artifacts, and this plan. This week's precedent
   (`063cf49`, `c398e7d` — **verified docs-only** this session) is docs-only
   commits on main; if the operator prefers the strict letter of the merge law,
   file a tiny docs task instead. Either way: no code rides with the docs commit.
3. **Convergence run FIRST (the operator's stated priority), via the CLI** —
   it depends on neither the fix pack nor Stream B (addendum A1). `npm run
   project create` a scratch repo, watch it converge, verify the four receipts,
   tear down, ledger the receipts. This proves the original request immediately
   and surfaces any live-network provisioning scar before more is built on top.
4. **File Stream A through the live intake** (Gemini officer + confirm-verify
   gate) — drill #2 begins. Junior A implements the fix pack **in the bureau
   worktree**; senior reviews; operator watches the tail: the success signal
   is `verify.run → needs-review → approve → pr.create → pr.merge → done`
   draining with **zero operator-side repair** (the live proof of F1/F2/F3).
5. **Stream B in parallel** (junior B), same loop — adds the *console* entry to
   the already-proven provisioning engine.
6. **Phase 8 kickoff**: `docs/phase-8-plan.md` D0-8 freeze cut from a clean,
   green main.

## Phase 8 entry checklist (all required)

- [ ] Fix pack merged with posted Senior verdict; its own merge drained the
      delivery tail unassisted (the live proof of F1/F2/F3)
- [ ] Stream B merged with posted Senior verdict
- [ ] Supervised provisioning run recorded in the ledger with receipts
- [ ] Docs committed; `git status` clean on main
- [ ] Suite green twice + build clean on merged main
- [ ] Ledger "In flight" emptied; this plan's follow-ups filed or closed

## Laws preserved (explicitly)

- Merge law absolute: streams on `wt/*` branches, Senior verdict before any
   merge, operator merges, no out-of-band delivery. F1–F3 make the tracked
   path *runnable*, they do not bypass or weaken any gate — the
   reviewed-commit-equals-tip guard, done-gate CHECK, and human approval all
   stay exactly as they refused tonight.
- Fail-closed seams stay fail-closed (F1 wires, doesn't default-open).
- No network in tests (fake providers everywhere; `gh` touched only in the
  supervised convergence run). API keys/credentials never transit bureau code.
- Every async step a job row; one journal door; refusals are `guardrail`
  spans. Tonight's three dead `pr.create` rows stay in the DB as the honest
  record.

## Out of scope (filed, not forgotten)

- `unregisterProject` / project deprovision (surfaced by the convergence teardown).
- The senior's declared residuals from the provisioning verdict: `'internal'`
  visibility admitted by schema, URL constructed not parsed from `gh` output,
  60s job timeout, CLI `--actor` cast, duplicate `setRepoProvider` alias.
- A1 hook install policy (blocks the department's own engine merges — resolve
  before Phase 9, not Phase 8).
- Backup-push scheduling per provisioned project.
- Phase 9/10 (kernel extraction, first new department) — after Phase 8 per
  `docs/plan-bureau-kernel-roadmap.md` Part C.
