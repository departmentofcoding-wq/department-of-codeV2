# Department of Code v2 — Full Context for the Multi-Department Blueprint

**Purpose of this file.** The operator is planning more departments (Dept of
Reddit, Dept of HFT, …) and needs (a) the complete design of this department
as it actually exists today, and (b) an honest split of what is
department-agnostic machinery ("the bureau kernel") versus what is the
software-development payload — plus the changes worth making in a "perfect
blueprint". This file is the source material for that blueprint. It is
deliberately untracked: committing it is the operator's decision, through the
normal flow.

Everything here was re-derived from the tree at `main` = `562d2a9`
(2026-08-26), suite 435/435 (one known browser-under-load flake, `t30`, passes
in isolation), `npm run build` clean.

---

## 1. What the department IS (one paragraph)

An LLM-driven software bureau: **LLM agents do the work, but a machine and a
protocol make their output trustworthy.** Juniors (coder agents driven in real
IDEs over CDP) implement; Seniors (reviewer agents — Claude CLI, ZCode/GLM)
review and return fail-closed APPROVE/REVISE verdicts; a human Operator holds
every critical gate (verify-command confirmation, final approval, merge). All
of it runs on one SQLite store where **invariants are enforced by the database
itself** (the done-gate CHECK), every asynchronous step is a durable job row,
every act writes an attributed, append-only journal span, and every loop is
bounded by a budget column. The department's real product is not the code its
agents ship — it is *provenance*: nothing is claimed that was not verified.

## 2. Current state snapshot (2026-08-26)

| | |
|---|---|
| Phase | 7 — Live operation (in progress). Phases 0–6 complete. |
| Shipped | **Two real tasks end-to-end**: assets tab (`c7f9b37`), ntfy notifications (`1c14534`) — filed → plan review → ZAI approve → junior implemented+committed → walkthrough review → merge. Plus console projects/mobile/ntfy (`e9a1b7f`), ZCode 3.8.1 senior recalibration (`e8f8097`). |
| Suite | 435 tests / 94 files, `tsc --noEmit` clean. |
| Agents drivable | 2 juniors (Antigravity IDE @9333, Antigravity 2.0 @9334), 2 seniors (claude CLI, zai/ZCode GLM @9335) — all driven from code over CDP/subprocess. |
| Console | 30 token-auth endpoints; tabs: Dashboard, Tasks (Live/Completed/Archived), Findings, Workers/Flow, Projects, Assets, Journal, Settings; intake chat front door. |
| In flight | Nothing (clean handoff). |
| #1 open gap | **Workspace/worktree reconciliation** — the harness junior writes in its own IDE workspace, not a bureau worktree, so the automatic `verify.run → needs-review → done` tail of the flow can't complete without a hand path. Hand-merges to `main` are PAUSED until this lands. |
| Next phases | Finish worktree reconciliation, then Phase 8: multi-task / concurrency at scale. |

## 3. Roles and the operating protocol (the human process)

**The role triangle:**
- **Operator (human)** — assigns streams, merges, owns keys/spend, the ONLY
  writer of approvals (`approveTask`), verify confirmations, re-arms of blocked
  tasks, archive/complete tags. Updates the ledger.
- **Senior (review-only agent)** — never writes code. Reviews plans and
  walkthroughs, returns `VERDICT: APPROVE|REVISE`, fail-closed parsing. One
  senior per task (deterministic assignment).
- **Junior (implementer agent)** — plans then implements on stream branches,
  one junior per task (deterministic assignment across A/B for parallelism).

**The review loop** (docs/DEPARTMENT_STATUS.md "Operating protocol", proven
across 7 phases):
1. Operator cuts one branch per stream (`wt/junior-<x>-<stream>`) from
   post-freeze `main` and briefs the junior (`docs/*-brief.md`).
2. Junior posts a **plan** (components, files, tests) for Senior review BEFORE
   any code.
3. Senior reviews the plan; blockers/amendments resolved first.
4. Junior implements; every PR **names the guard it broke and the test that
   caught it** — real mutation evidence in `docs/mutation-evidence-phase<N>.md`.
5. Junior posts a **walkthrough** with claims (test counts, demo output).
6. Senior **verifies claims independently** (suite run twice, build, demo,
   journal inspection) — claims are never trusted.
7. Operator merges and updates the ledger.
8. Clean handoff = the ledger's "In flight" row is filled before any window
   switch.

**The constitution (non-negotiables, from AGENTS.md):**
- Never work directly in `main`'s tree; one branch per stream, one PR per
  milestone.
- **Merge law:** nothing reaches `main` — commit, merge, docs and review
  artifacts included — without a posted Senior verdict for that exact commit
  hash. Ledger "done" rows cite the hash that actually contains the work.
- **No out-of-band delivery:** every merge is a tracked act (a `bureau_jobs`
  row + `journal()` span + task state transition). Hand-merges are paused
  until worktree reconciliation lands (enacted after the 2026-08-24 incident
  where two shipped tasks reached `main` by hand, leaving zero delivery-path
  evidence in the DB).
- Done requires verifier exit 0 AND human approval — enforced by DB CHECK.
- Every async step is a job row; nothing fire-and-forget.
- Budgets are columns, incremented transactionally with the state they bound.
- One journal door; full attribution on every act.
- API keys in env only — never DB, journal, messages, logs.
- Tests never touch the network or the live `db/bureau.db`.
- Walkthrough claims get verified, not trusted.

## 4. Architecture — the engine (subsystem by subsystem)

Stack: TypeScript, run directly via `node --experimental-strip-types`
(build = `tsc --noEmit` only). **One runtime dependency** (`zod`). SQLite via
`node:sqlite` `DatabaseSync` — no ORM, no external queue, no express (console
is raw `node:http`). Workspaces: `engine/` + `runner/`. Windows-first
(`taskkill /T /F` tree kills, `.lnk` shortcut installer).

### 4.1 The contract (`engine/contract/`)
The single place that states what the department IS — frozen vocabularies and
pure helpers, no I/O:
- `constants.ts` — `STATES` (8), `TRANSITIONS`, `ACTOR_ROLES` (11),
  `SPAN_KINDS` (11), `JOB_KINDS`, `JOB_STATES`, budget/meta key namespaces,
  ceilings (`plan_rounds`=7, `work_rounds`=5), `VACUOUS_VERIFY_COMMANDS`
  (`exit 0`, `true`, `:`, `echo ok`, …), `DETERMINISTIC_ATTRIBUTION`
  (`verifier/deterministic/core`).
- `types.ts` — every row interface, the `AttributionTuple`
  `{actor_role, provider, model, account}`, `DbConnection`, `JobContext`,
  and the provider interfaces (`LlmClient`, `IdeDriver`, `WorkspaceProvider`,
  `PrProvider`).
- `validation.ts` / `tools.ts` — `taskGaps()`, `isVacuousVerify()`,
  `formatActor()`, officer tool schemas, `scrubEnv`/`redactOutput`
  (key hygiene), `parseVerifyOutcome`.
- **Seams** (the testability pattern that makes everything work):
  `llm-seam`, `workspace-seam`, `ide-driver-seam`, `pr-seam`, `backup-seam`
  (+ `antigravity-seam`, `senior-seam`, `ntfy-seam` in their modules). Each is
  an override-able singleton: real impls registered by the runner/console at
  boot, fakes injected by tests. Fail-closed getters (throw if unregistered).
- `harness-pure.ts` — `mintNonce()`, `isCorrelated()`, `leaseIsExpired()`.
- Contract freezes are enforced by dedicated test files
  (`test/unit/contract_d0*.test.ts`, one per milestone freeze).

### 4.2 The database (`engine/db/`)
One SQLite file (`db/bureau.db`), WAL + busy_timeout + foreign_keys ON,
boot door runs schema + migrations on EVERY open ("no caller can open a
database that is one migration behind"). **22 `bureau_*` tables**, the core
ones:
- `bureau_tasks` — title, project_id, intent/spec/acceptance, verify_cmd,
  state (CHECK in 8 states), verifier_exit_code, approved_at/by, merged_at/by,
  **budget columns** `plan_rounds`/`verify_fixes`/`cycles`/`attempts`/
  `recover_attempts`, work_uuid/work_title (session identity), pull_request_url,
  orthogonal tags (archived_*, completed_* + completion_commit).
- `bureau_jobs` — kind, payload, state (pending/running/done/failed/dead),
  run_after, attempts/max_attempts, lease_owner/lease_expires_at, reaped_count.
- `bureau_journal` — append-only span log (UPDATE/DELETE aborted by triggers).
- Plus: projects, worktrees, verify_runs, models, assignments, meta, plans,
  plan_reviews, work_reviews, dispatches, intake_sessions (idempotency key,
  partial unique index), intake_messages (append-only), selectors,
  window_leases (partial unique active-per-window), observations (nonce
  UNIQUE), ownership (secretary), watchdog_findings (partial unique active),
  assets.

**The done-gate CHECK — the central invariant, at the storage floor:**
```sql
CHECK (state <> 'done' OR (verifier_exit_code = 0
       AND approved_at IS NOT NULL AND approved_by IS NOT NULL))
CHECK (merged_at IS NULL OR state = 'done')
```
No code path can bypass it (proven by raw-SQL tests).

**Migrations:** `ADDED_COLUMNS` idempotent `ALTER TABLE ADD COLUMN` list via
`PRAGMA table_info`; one-time table **rebuild** when a CHECK must change
(`blocked` state addition) with `foreign_key_check` inside a transaction;
partial indices sequenced after the rebuild. Archive/completion columns are
deliberately orthogonal markers that never touch `state`.

**`bureau_meta`** — runtime knobs with code defaults: ceilings
(`budget:rolling_24h_*`, `verify:fixes:ceiling`=2, `verify:timeout_ms`),
review ceilings (`review:plan_rounds_ceiling`=7, `review:work_rounds_ceiling`=5),
harness lease knobs, per-(model,key) cooldowns, ntfy config, seed markers.

### 4.3 The state machine (`engine/state/machine.ts`)
States: `intake, queued, claimed, verifying, needs-review, done, failed,
blocked`. Every `transition()` = read → `canTransition` (role-gated) → guarded
`UPDATE ... WHERE state=<expected> RETURNING *` → journal span, all in one
`BEGIN IMMEDIATE` transaction (concurrent movers refuse). Entering a notifying
state fires ntfy.

Edges in practice:
- `queued → claimed` — plan approved / ceiling-proceed (plan cycle), or
  `worktree.prepare` (foreman).
- `claimed → verifying` — `verify.run` (verifier).
- `verifying → needs-review` — verifier exit 0.
- `verifying → claimed` — verify failed, fix budget remaining (send-back loop).
- `verifying → blocked` — verify_fixes ceiling (verifier only).
- `claimed → blocked` — review-rounds ceiling after amend (senior only).
- `blocked → claimed` — `rearmTask` (human-operator only; resets fix budget).
- `needs-review → done` — `pr.merge` (system; then sets merged_at/by).
- Declared-but-unused (reserved): `intake→queued`, `claimed→queued`,
  `verifying→failed`, `failed→claimed`.

**Single-writer doors:** `approveTask` (ONLY writer of approved_at/by;
requires human-operator + needs-review + verifier_exit_code 0; enqueues
`pr.create` in the same transaction), `rearmTask` (ONLY resetter of blocked
budgets). Orthogonal human doors `archiveTask`/`markTaskCompleted` never touch
`state` — out-of-band shipped work is TAGGED completed, never a forged `done`.

### 4.4 The jobs system (`engine/jobs/`, `runner/main.ts`)
**Nothing fire-and-forget — every async step is a row.**
- Kinds: `intake.turn`, `plan.cycle`, `work.cycle`, `junior.dispatch`,
  `worktree.prepare`, `verify.run`, `senior.review-plan`,
  `senior.review-work`, `pr.create`, `pr.merge`, `backup.push`,
  `watchdog.sweep`, `watchdog.recover`, `secretary.claim/release`,
  `lease.reap`, `selector.calibrate`, demo kinds. Each registered with a zod
  payload schema, lazy handler, `{maxAttempts, timeoutMs}` — e.g.
  `plan.cycle`/`work.cycle` are maxAttempts 1 / 45 min (live GUI agents must
  not be blindly re-prompted).
- Claim = atomic `UPDATE ... WHERE id = (SELECT oldest pending, ready,
  kind NOT IN exclusions ...) RETURNING *`; heartbeats extend the lease;
  `reapExpiredJobs` flips expired-running → pending (`reaped_count+1`);
  dead-letter after reaped ≥ 3 + operator notify; backoff `100 * 2^attempts`.
- **Deterministic ids + INSERT OR IGNORE** for idempotency:
  `plan.cycle:<taskId>` (shared by filing door AND reconciler — they
  coordinate through the id, not a lock), `backup.push:<mergeCommit>`,
  `watchdog:sweep:next` (self-rescheduling cadence — no `setInterval`).
- **Chaining always inside the completing act's transaction** (see §4.6).
- Runner loop per tick: `reconcileQueuedTasks` → reap window leases + expired
  jobs + dead-letter → `claimJob` → execute (AbortController = shutdown +
  per-kind timeout; jobs run concurrently with the poll loop).
  `excludeKinds` lets co-located executors divide labor (console's background
  runner excludes `intake.turn`, which the console drains inline via
  `drainSingleJob`; a standalone `npm run runner` drains everything — the
  durability/resume path).

### 4.5 The journal (`engine/journal/writer.ts`)
One door, `journal()`. Append-only spans with the attribution tuple
`{actor_role, provider, model, account}` — e.g.
`junior-engineer/antigravity` on `gemini-3.7-flash`;
`verifier/deterministic/core`; Google keys attributed as slot `gkey-N`
(never material). 11 kinds: `llm, tool, guardrail, transition, human, system,
task-filed, project-registered, dispatch, observation, review`. The writer
validates kind + attribution and backfills work-session identity. Key
hygiene: `scrubEnv` (verifier child env stripped of `*_API_KEY` etc.),
`redactOutput` (all captured text), whole-DB scan test (T18). Spans carry
tokens/cost/latency → the ledger rollups (`engine/ledger/rollups.ts`) give
per-model attribution and per-work-session cost with an honesty flag
(`cost_recorded: false` ≠ "$0"). `docs/DEPARTMENT_STATUS.md` is the *human*
ledger (memory/law); this is the *machine* ledger (accounting) — two layers
of "nothing unaccounted".

### 4.6 The task lifecycle end-to-end (`engine/flow/`, `engine/harness/`, …)
1. **Intake** — Task Intake Officer (LLM, `engine/officers/task_intake_officer.ts`)
   converses (CLI or console chat), drafts title/intent/spec/acceptance/**verify_cmd**
   via tools; refuses vacuous verify commands; session budgets (10 model calls,
   10 inner turns); crash-repairs interrupted tool calls. **Human
   confirm-verify gate**: `confirmVerify()` requires human-operator
   attribution; touching verify_cmd resets confirmation. `fileTask()` in ONE
   transaction: session `open→filed`, insert task (`queued`), journal
   `task-filed`, enqueue `plan.cycle:<taskId>` (auto-kickoff, no double-file
   window).
2. **Plan cycle** (`engine/flow/plan_review_cycle.ts`) — junior AUTHORS a plan
   (must name branch, enumerable scope, tests + mutation evidence, walkthrough
   plan); **deterministic rubric gate BEFORE senior tokens** (garbage never
   gets billed); senior reviews with the task verbatim. APPROVE → `queued→
   claimed`, dispatch row + `junior.dispatch` enqueued (`chainWorkReview`).
   REVISE → next round with feedback threaded (same junior conversation).
   Ceiling-on-revise → **proceed to implementation with feedback threaded**
   (walkthrough review is the compensating gate; operator notified).
3. **Implementation** (`engine/harness/dispatch-job.ts`) — drives the real
   junior in its IDE; artifacts (plan/walkthrough/transcript) captured to
   `docs/junior-artifacts/<taskId>/` after `redactOutput`; `observation` span.
   On completion, same transaction enqueues `work.cycle`.
4. **Work review cycle** (`engine/flow/work_review_cycle.ts`) — the SAME
   senior reviews the walkthrough (round 1 fresh conversation; fixes go back
   to the SAME junior conversation). APPROVE → checkpoint worktree, record
   `reviewed_commit` = branch tip, enqueue `worktree.prepare`. REVISE ≤ 5
   rounds → fix prompt; ceiling → `blocked` + notify with required changes.
5. **Worktree prepare** (`engine/worktrees/`) — per-project repo root, path
   `<repoRoot>/.bureau-worktrees/<taskId>`, branch `bureau-wt-<taskId>`,
   base ref normalized (main→master→origin/HEAD→HEAD), adopts clean/stale
   worktrees, refuses dirty; checkpoints are attribution-signed commits.
   Chains `verify.run` idempotently.
6. **Verify** (`engine/verify/`) — `claimed→verifying`; verify_cmd read
   strictly from the DB row (never the workspace), scrubbed env, timeout,
   tree-kill; run row + `tool` span + outcome + `completeJob` in ONE
   finalization transaction; re-entry tolerant. Exit 0 → `needs-review`.
   Fail + budget → `verify_fixes+1`, `→claimed`, re-enqueue (bounded fix
   loop). Ceiling → `blocked`.
7. **Operator approve** — console button or CLI (`scripts/approve.ts`,
   type-`<taskId> CONFIRM`); `approveTask` enqueues `pr.create`.
8. **Delivery** (`engine/delivery/`) — `pr.create` re-checks preconditions in
   a transaction **including `reviewed_commit === current branch tip`**
   (nothing merges that the senior didn't review), then push + PR via the
   seam, enqueue `pr.merge`; merge re-checks, `transition done` +
   `merged_at/by`, enqueue idempotent `backup.push:<tip>`, prune worktree.
9. **Backup** (`engine/durability/backup_push.ts`) — push, then read the
   REMOTE tip back and compare (anti-false-claim; mismatch = guardrail +
   throw).
10. **Reconciler** (`engine/flow/reconcile.ts`) — every runner tick sweeps
    queued tasks with zero plan-cycle jobs (bounded, idempotent; failed
    cycles are NOT auto-retried — explicit operator action).

### 4.7 The harness (`engine/harness/`) — driving real agent GUIs from code
- **Juniors** (`antigravity.ts`): `JUNIORS` registry — A = Antigravity IDE
  (CDP 9333), B = Antigravity 2.0 (CDP 9334); detect-or-launch; window
  targeting by URL (not title — titles track the active chat);
  `ensureChatInputReady` (the readiness gate that fixed a stranded-task bug);
  `newConversation`; `sendPrompt` **verified at both ends** (insert confirmed,
  submit confirmed, stale drafts cleared with real key events — a content-
  editable's DOM is never trusted); `selectModel`/`selectFolder`;
  `captureArtifacts`. `assignJunior` = deterministic task-id hash (one junior
  per task, two juniors for cross-task parallelism).
- **Seniors** (`senior.ts`): `SENIORS` registry — claude (CLI subprocess,
  `claude -p --append-system-prompt`) and zai (ZCode/GLM desktop, CDP 9335).
  Review-only prompts ("You do NOT write code… reply MUST begin with
  VERDICT:"). `parseVerdict` **fail-closed** (no marker → REVISE);
  `detectUncapturedReview` refuses phantom verdicts. `assignSeniorForTask` =
  one senior per task across BOTH reviews. Calibrated for ZCode 3.8.1: submit
  clicks `button[data-testid="v4-composer-send"]`, completion = Stop control
  gone / Send re-enabled — never DOM text (GUI selectors are version-fragile;
  prefer stable data-testids).
- **Adaptive wait** (`agent-wait.ts`): wait while the agent is genuinely
  working (Stop control, standalone status label, or transcript growing) — no
  elapsed cap; stall = 120 s inactivity; `AGENT_PROGRESS_LABEL_RE` matches
  only standalone labels so prose like "working tree clean" can't fake
  activity. `ensureCompleted` refuses to record partial output.
- **Selector registry + calibration gate** (`engine/selectors/`): named
  selectors with lifecycle `draft→calibrating→calibrated|failed`
  (matchCount must be exactly 1, repeatedly); `GatedIdeDriver` wraps every
  read/act and refuses uncalibrated selectors (guardrail span) — the Runner's
  default composite, so the gate is unbypassable on the standard path.
- **Nonce correlation**: every driver act returns a nonce echo; span detail +
  observation row + driver echo must triple-match — proof the GUI really did
  what the DB claims; crash-safe, no orphans.
- **Window leases** (`lease-manager.ts`): unique partial index on active
  lease per window target; acquire/heartbeat/release/reap; dispatches always
  release in `finally`.

### 4.8 The LLM layer (`engine/llm/`)
`callModel` is the single choke point: budget guard FIRST (rolling 24h
tokens/requests computed from the journal vs meta ceilings → guardrail +
notify + throw), candidates from role assignments, proactive steering by
live quota headroom (per model×key RPM/RPD/TPM read from the journal),
rotation on 429 with per-pair cooldowns in `bureau_meta`. Providers: Ollama
(local), Google/Gemini multi-key (env + gitignored `secrets/google.env`
0600, masked display, journal records `{count}` only), mock
(`BUREAU_MOCK_LLM` / seam override / per-call client). Google error strings
built from status codes only — never response bodies.

### 4.9 Support systems
- **Watchdog** (`engine/watchdog/`) — read-only sweep (self-rescheduling job
  row) for 4 stranded classes (verifying-with-no-run, expired-lease-unreaped,
  dead-lettered-with-retries-left, dispatch-without-lease); idempotent
  findings; bounded recovery (≤3 attempts) then operator notify.
- **Secretary** (`engine/secretary/`) — named-key ownership leases
  (fail-closed while live, expired reclaim, holder-only release).
- **Dashboards** (`engine/dashboards/views.ts`) — pure read-only projections:
  state populations, budget spend per task, verify failure rate, span counts,
  guardrail count, **worker roster** (role → model + live active/idle),
  **task flow** (every in-flight task on Intake→Queued→In progress→Verify→
  Review→Done with owner, budgets, 15-min stall/stuck flag).
- **Notifications** (`engine/notifications/`) — ntfy push; single-source
  event catalog (`events.ts`) drives BOTH the triggers
  (`claimed`, `needs-review`, `blocked`, `failed`, `done`) and the Settings
  UI list; dept-online ping; test-send endpoint; spans record
  `topicConfigured`, never the topic.
- **Projects** (`engine/projects/`) — multi-repo: `registerProject` (must be
  an on-disk git repo; auto-appends `/.bureau-worktrees/` to its gitignore;
  journaled); tasks carry `project_id`; prompts inject project context.
- **Assets** (`bureau_assets` CRUD) — department resource register behind the
  token check with an XSS-safe href guard.

### 4.10 The Operator Console (`console/`, `scripts/console.ts`)
Local control panel: loopback-only bind, per-launch 32-byte token (header or
`?token=`, exchanged into sessionStorage), **30 endpoints, all token-auth**,
1 MB body cap, path-traversal guard, everything through `redactOutput`, all
state changes are POST + journaled + attributed `human-operator`; trigger
buttons enqueue job rows (never inline work). Vanilla-JS frontend (no
bundler), mobile-responsive. Starts a background Runner
(`excludeKinds:['intake.turn']`). Desktop/Start-menu shortcut installer.

### 4.11 Tests (`test/`)
435 tests / 94 files. Law: never touch the network or live DB; temp paths +
cleanup; all external worlds (LLM, PR, workspace, IDE, senior, ntfy) injected
as fakes at the seams. T-numbered integration records mirroring plan
milestones, `tc*` units, per-freeze `contract_*` tests. `vitest.config.ts`
has `fileParallelism:false` (known debt: crash-kill/browser tests contend
under parallel load; today's `t30` full-suite flake is this class — it passes
in isolation).

## 5. The phase methodology (how the department grew)

Proven across 8 phases (0 foundation, 1 intake, 2 worktrees+verifier,
3 junior harness, 4 senior+gates+delivery, 5 hardening, 6 console,
7 live operation, 8 planned concurrency):

1. **Rough outline** (`phase-N-rough.md`) — scope sketch motivated by real
   incidents + draft exit sentence + open questions.
2. **Frozen plan** (`phase-N-plan.md`) — written for a window with NO memory:
   cut-from hash, **exit sentence** (quotable definition of done), safety
   posture, **D0 contract-freeze milestone** (schema-only via the boot
   migration door, frozen types/vocab, merged BEFORE streams branch), then
   Streams A/B with named tests (T-numbers) and required mutations.
3. **Junior briefs** (`*-junior-x-brief.md`) — per-stream assignment letters:
   branch, pre-flight checklist (ledger → plan → suite green), milestone
   specs, definition of done, carry-forward advisories.
4. **Implementation** on `wt/junior-<x>-<stream>` branches; **mutation
   evidence** per guard (exact edit → real test failure output → restore →
   green), recorded in `docs/mutation-evidence-phase<N>.md`; the Senior
   independently re-executes representatives.
5. **Walkthrough** (`docs/reviews/walkthrough-*.md`) with explicit claims.
6. **Senior verdict** (`docs/reviews/verdict-*.md`) — what was verified
   independently (suite twice, build, demo, journal, mutation re-runs),
   APPROVE/REVISE, citation errata.
7. **Operator merge + ledger update.** Phase done = merged, green on main,
   exit sentence demonstrable (demo script or recorded run), ledger updated.

## 6. Scars — rules written from real incidents (each traces to a date + hash)

1. **Out-of-band merge** (2026-08-24/25): shipped work hand-merged to `main`
   left zero delivery evidence in the DB. → Every merge is a tracked act;
   hand-merges paused until worktree reconciliation.
2. **Unanchored gitignore**: `db/` silently kept `engine/db/` out of commits;
   main couldn't build. → Anchor patterns; check `git status --ignored`.
3. **Uncommitted main**: a milestone sat untracked in main's tree. → Branches
   mandatory; "done" = committed on a stream + merged by Operator.
4. **Live-DB pollution**: a demo wrote a fake task into `db/bureau.db`. →
   Tests/demos use temp paths only; the live DB is bureau property.
5. **Fake mutation**: a "mutation test" that filtered its own input proved
   nothing. → Mutate real code, watch a real test fail, restore, record logs.
6. **Greenwashed claims** (multiple): "build clean" while `tsc` actually
   failed on another branch's imports; "clean exit 0" while the demo hung and
   leaked a browser. → Claims re-run, never trusted.
7. **Cross-stream registry contamination** (twice): a stream wired another
   stream's not-yet-merged code. → Registry edits stay with their milestone.
8. **GUI selector fragility**: ZCode 3.8.1 broke the senior (Enter no longer
   sends; home-screen heuristics read composer controls as "home"). → Prefer
   stable `data-testid`s; never treat contenteditable DOM text as a submit
   signal.
9. **Completion-detection false positive**: matching the word "working"
   anywhere wedged a 45-min wait. → Standalone-label regex; adaptive wait.
10. **JS runtime vs tsc drift**: `--experimental-strip-types` forbids TS
    parameter properties that `tsc` accepts. → Explicit field assignment.

## 7. THE BLUEPRINT SPLIT — bureau kernel vs department payload

### 7.1 The kernel (department-agnostic — clone verbatim)
- **The governance spine**: one SQLite store; invariants as DB CHECKs
  (done-gate pattern: terminal state requires machine-proof + human-approval
  columns); budgets as columns incremented transactionally with the state
  they bound; runtime ceilings as meta keys with code defaults.
- **Jobs machinery**: claim/lease/heartbeat/reap/dead-letter/backoff,
  deterministic ids + INSERT OR IGNORE idempotency, chaining inside the
  completing transaction, self-rescheduling cadence jobs, `excludeKinds`
  co-located executors, `drainSingleJob` CLI door.
- **Journal**: one door, append-only, attribution tuple, key hygiene
  (`scrubEnv`/`redactOutput`/whole-DB scan test).
- **State machine skeleton**: guarded role-gated transitions, single-writer
  doors for privileged columns, orthogonal human tags (archive/complete)
  instead of forged terminal states.
- **Seams pattern** for every external world + fail-closed getters; runner
  wires real providers, tests inject fakes.
- **LLM choke point**: budget guard → assignment → steering → rotation →
  journaled calls. Multi-provider (local-first), mockable.
- **Harness machinery**: CDP detect-or-launch, verified sends, adaptive
  completion wait, selector calibration gate, nonce correlation, window
  leases. (Works for ANY agent GUI, not just IDEs.)
- **Support**: watchdog (stranded-class detection + bounded recovery),
  secretary leases, dashboards (roster + flow stepper), ntfy notifications
  from a single event catalog, ledger rollups.
- **Console pattern**: loopback + per-launch token, POST-only mutations,
  trigger buttons enqueue jobs, background runner split by kind.
- **The process layer**: AGENTS.md bootstrap, DEPARTMENT_STATUS.md memory,
  phase lifecycle (rough→plan→D0-freeze→streams→briefs), the review loop,
  mutation evidence, walkthrough/verdict artifacts, exit sentences, scars.
- **The test law**: no network/live-DB, fakes at seams, T-records,
  contract-freeze tests.

### 7.2 The payload (the per-department part — what you swap)
| Seam | Dept of Code (today) | Dept of Reddit (example) | Dept of HFT (example) |
|---|---|---|---|
| **Task shape** | code change: intent/spec/acceptance/verify_cmd | content item: post/comment/mod-action + policy acceptance + check_cmd | strategy change: hypothesis/spec/risk-limits + backtest_cmd |
| **Officer role** | drafts a code task | drafts content/moderation work, cite sources, subreddit rules | drafts strategy + experiment design |
| **Verify semantics** | run test suite (exit code) | policy checker, rate-limit budget, format lint (exit code) | backtest + unit tests + risk-limit breach check (exit code) |
| **Workspace** | git worktree per task (`WorkspaceProvider`) | draft staging area / content sandbox | strategy repo + config sandbox |
| **Delivery** | `PrProvider`: push → PR → merge → backup push | `DeliveryProvider`: scheduled submission via API, human approval = needs-review gate | `DeliveryProvider`: deploy paper-trading; promote live only behind human gate + spend cap |
| **Juniors** | Antigravity IDE agents (coder) | research/draft agents (browser-driven or API) | quant/dev agents |
| **Seniors** | code reviewers (Claude CLI, ZCode) | policy/quality/toxicity reviewers | risk + code reviewers (maybe 2 seniors: risk, correctness) |
| **Assets register** | repos, docs | subreddits, accounts (never credentials — env only), flair/rules docs | venues, instruments, colo endpoints |
| **Budgets/ceilings** | rounds, fixes, tokens, requests | posts/hour, karma-risk, account-safety toil | compute cost, capital-at-risk, order-rate caps |
| **Watchdog classes** | stranded tasks/leases | stuck submissions, rate-limit proximity | stale strategies, position/latency anomalies |
| **Notifications** | ntfy on gate states | + mod-queue alerts | + breach/paper-vs-live divergence alerts |

**Key insight for the blueprint:** the flow skeleton
`intake → plan (junior authors, rubric, senior approves) → implement →
verify (deterministic, exit-code) → review (senior, fail-closed) →
HUMAN GATE → deliver → done (DB-proven) → notify/backup` is fully generic.
Every domain difference hides behind an existing seam: verify stays "a
deterministic command with an exit code, owned by the bureau, never the
workspace"; delivery stays "a provider interface behind a precondition
transaction"; the workspace stays "an isolated per-task sandbox behind a
provider".

### 7.3 Changes for the "perfect" blueprint (from this dept's own open items + design observations)
1. **Fix the workspace gap first.** The #1 live gap here: the driven agent
   works in its own workspace, not the bureau's, so the automatic tail
   (verify → done) can't close without hand paths (which then had to be
   outlawed). In the blueprint, make **"the place the agent actually
   writes"** a first-class pluggable concept from day one
   (`AgentWorkspaceBinding`): the harness session and the verification path
   must share one source of truth for the task's working copy.
2. **Extract a shared kernel package** (`bureau-core`: db schema + boot
   migrations, jobs, journal, state machine, seams, watchdog/secretary/
   dashboards/notifications, runner, console skeleton) with per-dept
   packages owning only the payload (officer prompt+tools, verify command
   semantics, workspace/delivery providers, harness rosters, rubrics).
   One SQLite DB **per department** (isolation of live state; the live-DB
   scar generalizes), shared code. Consider a `bureau-*` CLI that can
   operate on any dept's DB.
3. **Enforce the merge law with tooling, not prose.** Here it's law +
   review discipline; a blueprint should add machine enforcement — protected
   branch / server-side hook (or a local pre-merge hook that refuses merges
   lacking a delivery-path journal span for the tip commit).
4. **Drop or implement the dead edges.** `intake`, `failed` states and the
   `verifying→failed`, `failed→claimed`, `claimed→queued` edges are declared
   but unused — in a fresh blueprint either wire them (retry semantics) or
   remove them (smaller CHECK surface).
5. **Adopt event-based test waits from day one** (retire the
   `fileParallelism:false` band-aid; today's t30 flake is this debt).
6. **Make cost/risk accounting real before scaling.** `cost_usd` exists but
   "budgets have not met a real bill". For HFT the same columns become
   capital-at-risk — the blueprint should define the budget-guard as
   generic spend columns with per-dept units.
7. **Multi-senior review policies.** Here: one senior per task (efficiency).
   HFT likely wants two *roles* (risk + correctness); Reddit wants
   policy-toxicity. Make the review-assignment policy pluggable
   (single-reviewer default, role-based quorum optional).
8. **Federate later, isolate first.** One console per department (same
   skeleton/components), a cross-dept overview only after 2+ departments
   exist. Shared: harness manuals pattern (`docs/*-integration.md`), scars
   ledger format, phase methodology.
9. **Keep the two-ledger pattern.** Machine journal + human status doc is
   the department's actual memory system; both are needed and they reference
   each other (hashes ↔ spans).
10. **Honest-attribution rules generalize unchanged**: never fabricate model
    names (`unspecified` sentinel), key slots not keys, `cost_recorded:
    false` ≠ $0, fail-closed verdicts, anti-false-claim readbacks on every
    external push.

---

## 8. Key file map (for whoever builds the blueprint)

```
AGENTS.md                     session bootstrap + constitutional law
docs/DEPARTMENT_STATUS.md     cross-session memory (read FIRST, always)
docs/phase-N-{rough,plan}.md  phase lifecycle; exit sentences
docs/*-junior-x-brief.md      per-stream assignment letters
docs/reviews/{verdict,walkthrough}-*.md   review artifacts
docs/mutation-evidence-*.md   guard→mutation→failure→restore records
docs/{senior,antigravity}-integration.md  harness manuals
engine/contract/              vocabularies, types, seams, validation
engine/db/                    schema (22 tables), boot migrations, adapter
engine/state/                 machine (transitions, doors), archive, completion
engine/jobs/                  registry, claim/lease/reap, deterministic ids
engine/journal/               the one door + queries
engine/llm/                   callModel, providers, keys, rotation
engine/officers/  engine/intake/  engine/filing/   birth of a task
engine/flow/                  plan_review_cycle, work_review_cycle, reconcile
engine/harness/               antigravity, senior, cdp, agent-wait, dispatch
engine/verify/                deterministic verifier + bounded fix loop
engine/worktrees/  engine/projects/   isolation + multi-repo
engine/delivery/  engine/durability/  pr.create/merge, backup readback
engine/watchdog/ engine/secretary/ engine/dashboards/ engine/notifications/
runner/main.ts                job loop + provider wiring + drainSingleJob
scripts/                      intake/approve/console/dashboard/run_junior/...
console/                      node:http server + contract (30 endpoints) + public/
test/                         unit + integration, helpers/fakes, fixtures
db/bureau.db (+backups/)      the live store (bureau property)
secrets/google.env            gitignored keys (env wins)
```
