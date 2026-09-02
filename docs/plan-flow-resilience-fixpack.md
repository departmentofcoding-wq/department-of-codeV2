# Flow-resilience fix pack — review findings + fix plan

Status: **2026-08-30.** Written after the post-PR-#4 break: the department
shipped four tasks through the tracked flow (PRs #1–#4), then the first
new-project round died. This doc is the full review of the new machinery
(project provisioning, multi-project tasks, the delivery tail) and the plan to
fix what broke. Untracked by design; committing is the operator's call.

Tree state at review time: local main `d334004`, suite **587/587** (109 files)
and `npm run build` clean **with ~320 lines of uncommitted hotfixes sitting in
main's tree** (see F6). Live DB consulted read-only.

---

## Part 1 — What actually happened (evidence)

The "few successful ones": `6490336d` (PR #1), `1429a7de` (PR #2),
`7ef423f2` (PR #3), `5d29e47b` (PR #4) — all `done`, all through
approve → pr.create → pr.merge. Real successes, but each left **dead jobs in
the tail** (F1/F2 below). Then the new-project round (2026-08-29):

1. **06:40** — Operator provisions "trading analysis" from the console.
   The endpoint enqueues `project.provision:dept-trading analysis` (a space in
   the job id) without validating; the slug guard fires **inside the job**,
   three attempts burn, job dead (journal #846–#857).
2. **06:43** — Workaround: project registered by hand via the Projects tab as
   `Trading data analysis` → folder **`D:\projects\Trading data analysis`
   (spaces in the path)**; `registerProject` doesn't validate that either.
3. **07:40** — Task `3756ec6e` "Add a hello marker file" filed on the new
   project through the agent door; auto-kickoff enqueues `plan.cycle`.
4. **07:41–07:42** — plan.cycle dies twice: attempt 1 "no CDP endpoint on port
   9333 within timeout" (the 30s port-wait lost to a cold Antigravity start),
   attempt 2 "workbench window did not become available in time" (the fixed
   20×1s attach loop lost to the 30–40s cold render). Job **dead**, task
   stranded at `queued` (journal #862–#867).
5. The reconciler deliberately does not retry dead cycles, and the console has
   no re-kick action → the flow stops until a human runs a node script.

That is "the flow broke again": one UX-level refusal (slug), one latent hazard
accepted (space in path), one harness race (cold start), and no recovery door.

## Part 2 — Findings (ranked)

### F1 (P0) — Synchronous subprocesses freeze the runner → lease reap → duplicate job execution
- `GhCliPrProvider` (`engine/delivery/gh_cli_pr_provider.ts:1`), 
  `ExecGitBackupProvider` (`engine/durability/git_backup_provider.ts:1`), and
  `repo_provider.ts:1` all use **`execFileSync`**.
- The job lease default is **5s** (`BUREAU_LEASE_MS`, `runner/main.ts:27`) with
  a 1s heartbeat — but heartbeats are `setInterval` callbacks: they cannot fire
  while `execFileSync('gh', …)` / `git push` blocks the event loop for 6+s.
- Two runners are live by design (console background runner + standalone
  `npm run runner`; the 08-29 journal shows ≥2 distinct runner ids and three
  console starts). The second runner's reaper (poll 100ms) flips the expired
  job to pending and re-claims it **while the first runner is still executing**.
- Proof (task `5d29e47b`, journal #790–#812): claim 16:17:33.753 (lease
  expires 16:17:38.753) → reaped 16:17:38.806 → re-claimed by the other runner
  16:17:38.830 → runner 1 creates PR #3 at 16:17:39.761 → runner 2's duplicate
  `gh pr create` fails (gh refuses a second PR for the branch) → zombie copy
  retries ×2 against a now-`done` task ("must be needs-review") → dead-letter
  + 2 guardrail spans. Identical shape for `7ef423f2` and `1429a7de`.
- The fail-closed guards held (nothing merged twice) — but every delivery
  spawns a duplicate-execution race and dead-letter noise, and at N concurrent
  tasks a duplicate `junior.dispatch`/`verify.run` is only one unlucky timing
  away.

### F2 (P0) — `backup.push` is structurally broken after server-side PR merges
- `pr.merge` merges the PR **on GitHub**; origin/main advances; local main is
  now behind. The chained `backup.push:<tip>` then runs `git push origin main`
  from the local repo → `! [rejected] (fetch first)` → 3 attempts → dead.
  Four dead `backup.push` jobs across 08-26→08-28 prove it repeats every merge.
- Side effects: local/origin diverge after every delivery (the manual
  `40e4157`-style reconcile), and the durability guarantee silently degrades
  to "the operator pushed by hand."
- Also: `ExecGitBackupProvider` defaults `repoRoot = process.cwd()` — wherever
  the runner happened to start, not necessarily the main repo.

### F3 (P0) — Junior cold-start attach race (the actual new-task killer)
- `ensureJuniorRunning` waits a fixed **30s** for the CDP port
  (`engine/harness/antigravity.ts:~180`); a cold Antigravity under load can
  exceed it (attempt 1 died at ~33s).
- The workbench attach loop was a fixed 20×1s while the (VS Code fork) IDE
  takes **30–40s** after the port answers to expose an attachable page target
  (attempt 2's death).
- The uncommitted working-tree fix already addresses the attach half:
  `MAIN_WINDOW_ATTACH_MS = 60000` + recovery waits for the window, + console
  port-reclaim (`scripts/console.ts`), + 3 resilience tests. It is correct,
  suite-green — and **unreviewed and uncommitted in main's tree** (see F6).

### F4 (P0) — A dead `plan.cycle` strands the task with no recovery door
- Reconciler won't re-kick failed cycles (by design); the only recovery is the
  operator's manual `enqueueJob` node path (used 08-27 for `1429a7de`, needed
  again now for `3756ec6e`). Every harness hiccup = a human writing code.
- Same gap for dead `junior.dispatch` jobs (the documented "re-enqueue the
  identical payload" runbook exists only as prose).

### F5 (P1) — Provisioning validates inside the job, not at the door; deterministic refusals retried ×3
- `POST /api/projects/provision` builds `canonicalName = repoPrefix + rawName`
  and enqueues without slug validation; the guard fires in the handler after
  the job exists (journal #848–#857: enqueue → guardrail ×3 → dead).
- Retry policy burned 3 attempts on a **deterministic** validation error.
  Same for pr.create's state refusals (retried ×2 after the task was done).
- `registerProject` accepts any name/path → the workaround registered a repo
  at a **space-bearing path**, a latent hazard for every composed-command seam
  downstream (verify_cmd execution, worktree/git operations in that repo).

### F6 (P0, process) — Uncommitted hotfixes in main's working tree
- ~320 lines across `engine/harness/{antigravity,antigravity-seam,dispatch-job}.ts`,
  `scripts/console.ts`, `test/unit/tc_junior_resilience.test.ts`, and the
  ledger. Real fixes (F3 + EADDRINUSE double-console), suite 587/587 + build
  clean with them — but they violate "never work in main's tree / verdict
  before merge" and are load-bearing for the next run. They must travel the
  loop (Stream 3) or be deliberately reverted; they must not keep drifting.

### F7 (P2) — Post-merge worktree prune fails EPERM on Windows
- `pr.merge`'s prune of `.bureau-worktrees/<taskId>` hit `EPERM` (the junior
  IDE still holds the directory) — warning-only today, but it accumulates
  stale worktrees at exactly the rate Phase 8 plans to multiply.

### F8 (P2) — Legacy stranded rows pollute the Live view
- `82b97764` (`queued` since 08-21), `e489b734`/`33ace9f7`/`e156395d`
  (`claimed`) — all shipped/tagged out-of-band historically. The orthogonal
  archive/complete tags exist for exactly this; they were never applied.

### Minor observations
- ntfy `done` notification failed once (`success:false`, 16:17:51 08-28) —
  check topic health; not investigated further.
- Three `ntfy_department_online` pings on 08-29 = three console starts; the
  uncommitted port-reclaim fix addresses the double-console crash case.
- The agent door auto-confirm (`agent-auto-confirm-verify`, span #860) worked
  as designed; attribution correct.

---

## Part 3 — Fix plan

Order matters: Streams 1–2 cure what poisons **every** delivery; Stream 3
unblocks the stranded new-project task and lands the hotfixes lawfully;
Stream 4 hardens the provisioning front door; Stream 5 is hygiene. Each stream
= one `wt/` branch, one senior verdict, one `--no-ff` merge, mutation evidence
for every guard.

### Stream 1 — Kill the duplicate-execution mechanism (F1)
1. Convert `execFileSync` → promisified `execFile` in `gh_cli_pr_provider.ts`,
   `git_backup_provider.ts`, `repo_provider.ts` (same args/env/cwd; errors
   keep the same messages so tests/journal strings stay stable).
2. Raise `BUREAU_LEASE_MS` default 5000 → 30000 as belt-and-suspenders (any
   remaining sync island or long GC pause no longer reaps a live job; genuine
   dead runners still get reaped within ~30s + poll).
3. Tests: (a) a job handler that awaits a 8s fake-provider call keeps its lease
   while a second runner's reaper ticks — assert single execution, no reap;
   (b) regression: the old 5s default + blocked loop reproduces the reap
   (documented as the mutation). Mutations: revert promisify (heartbeat-starved
   → reap test fails); revert lease default.
4. **Operator relief available TODAY without code:** relaunch runners with
   `BUREAU_LEASE_MS=30000` — shrinks (not removes) the race until this lands.

### Stream 2 — Make the delivery tail true again (F2)
1. `backup.push` semantics after server-side merges: `git fetch origin` first;
   if the merge commit is already an ancestor of `origin/main` → complete with
   an `already_on_remote` span (readback proof, no push). Push only when local
   is genuinely ahead (local engine-dev merges). Keep the anti-false-claim
   readback as the terminal check in both paths.
2. `pr.merge`: after the GitHub merge, best-effort `git fetch` + fast-forward
   local `main` to the merge commit (journaled) — stops the local/origin
   divergence that forced manual reconciles.
3. Construct `ExecGitBackupProvider` with the explicit main repo root at boot
   (runner + console), never `process.cwd()`.
4. Tests: remote-ahead → verify-only success; local-ahead → push; mismatch →
   guardrail; fast-forward of local main after pr.merge. Mutations on the
   ancestor check and the readback.

### Stream 3 — Cold-start attach + recovery doors + land the hotfixes (F3, F4, F6)
1. Branch `wt/junior-<x>-flow-resilience` carrying the current uncommitted
   diff **verbatim** (attach budget, recovery window-wait, console port
   reclaim, the 3 resilience tests) — nothing else mixed in — through the
   review loop.
2. Raise `ensureJuniorRunning` port-wait default 30s → 90s (same class of
   cold-start budget; env-overridable), with a test.
3. New console action `POST /api/tasks/:id/rekick` (human-operator, journaled,
   idempotent): re-enqueue `plan.cycle:<taskId>` when the cycle job is dead and
   the task is `queued`; re-enqueue a dead `junior.dispatch` from its stored
   payload when the task is `claimed` (productizes the 08-27 manual runbook).
   Refuses live jobs and wrong states. Tests + mutation (remove the dead-job
   guard → duplicate dispatch attempt fails the test).
4. ENDPOINTS count bump; walkthrough claims re-run.

### Stream 4 — Provisioning at the door + path hygiene (F5)
1. Export the pure slug validator from `provision.ts`; `POST
   /api/projects/provision` validates **before** enqueueing and slugifies the
   name (`trading analysis` → `dept-trading-analysis`), echoing the derived
   canonical name; the job id is built from the slug.
2. Non-retryable error class: validation/precondition guardrail refusals fail
   **terminal on attempt 1** (provision slug, pr.create state checks). General
   fix in `failJob` semantics, honored by both handlers.
3. `registerProject` path guard: refuse whitespace-bearing repo paths (or
   normalize + warn — decide at plan freeze; recommendation: refuse, matching
   the slug law) with a clear message suggesting the dashed form.
4. One-time operator repair (journaled): rename
   `D:\projects\Trading data analysis` → `D:\projects\trading-data-analysis`
   and update the project row; then re-kick `3756ec6e` through the new door
   with junior A up on port 9333 — this also becomes the live proof for the
   stream's walkthrough.
5. Tests: 400/slugify paths, terminal-on-validation, registerProject guard,
   mutations.

### Stream 5 — Hygiene (F7, F8)
1. Prune-on-EPERM: bounded retry (defer to the watchdog sweep / a retry job
   with backoff) instead of warn-and-abandon.
2. Archive/complete-tag the legacy rows (`82b97764`, `e489b734`, `33ace9f7`,
   `e156395d`) from the console — orthogonal tags, zero forged `done`.
3. Check the ntfy topic once (the lone `success:false`).

### Sequencing and exit
1 → 2 → 3 (3 can start in parallel; it must land before the next task run) →
4 → 5. Exit sentence for the pack: *"File a task on a freshly provisioned
project with a space-bearing name; the door refuses/slugifies it; the flow
cold-starts the junior, survives the attach window, and the delivery tail
closes with zero dead jobs in `bureau_jobs` and local == origin on main."*

### Already tracked elsewhere (not duplicated here)
- Window-lease heartbeats for long GUI dispatches = P1.2 in
  `docs/plan-pre-phase8-remaining.md` (related but distinct from job leases).
- Journal legibility (P2.5 there) unchanged.
