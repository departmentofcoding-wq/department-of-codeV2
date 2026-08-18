# Department of Code v2 — Phase 4 Plan: Senior Review Gates, Operator Approval, Delivery (PR + Merge)

Handoff document for the two Junior Engineers. Senior Engineer: GLM-5.2
(Z.ai/ZCode). Every milestone ends in a pull request the Senior reviews; the
Human Operator approves and merges — and per AGENTS.md, nothing reaches main
until a Senior verdict is posted for that exact commit hash. Phase 4 turns
the review loop that Phases 1–3 ran by protocol into machinery: a Senior
officer that reviews plans and work, the one operator approval door, PR
creation from the task's worktree, and merge with worktree cleanup. The exit
sentence:

A junior's plan is bounded by `plan_rounds` and reviewed by a Senior whose
deterministic rubric runs before any model call; the work earns a verdict
recorded against the exact branch-tip commit hash; the operator approves
through the one approval door and `approveTask` remains its only writer; the
PR is created from the task's worktree and merged only when the database
agrees — verifier exit 0 AND recorded approval AND a verdict for the hash
being merged — and the worktree comes home pruned; no code path marks a task
done, and no merge executes, without the recorded chain.

## 0. Ground rules (all of Phase 1–3's, plus)

Read AGENTS.md and `docs/DEPARTMENT_STATUS.md` first. The merge-discipline
law is standing; Phase 4's point is to make it code.

Branches: `wt/junior-a-review` and `wt/junior-b-delivery`, cut from main
after the D0 freeze merges. One PR per milestone.

**The verdict-hash law becomes code.** `pr.merge` refuses to execute unless
a `bureau_work_reviews` row exists with `verdict = 'approved'` and
`reviewed_commit` equal to the branch tip **re-read inside the merge
transaction** — a review of hash X never merges hash Y. The DB backs the
done side (the Phase 0 CHECK: `done` requires `verifier_exit_code = 0` and
`approved_at`/`approved_by`); the code guards the merge side.

**`approveTask` is and remains the single writer** of `approved_at` and
`approved_by` (`engine/state/machine.ts:75`). The approval door is
interactive — a typed confirmation naming the task, never an env var, never
a flag, never a model. Approval journals a `human` span. The door refuses
tasks whose verifier did not exit 0, and is idempotent on re-approval.

**The cheap gate runs first.** Deterministic rubric checks (scope respected,
tests and mutations named, verifier exit 0 where applicable, diff matches
plan) execute before any model call; their refusals are `guardrail` spans
and cost zero tokens. The model is the expensive half of the review, never
the first.

**The PR provider is a seam.** `PrProvider` (push branch, create PR, merge
PR) lives in the frozen contract with the usual override triple, mirroring
`workspace-seam.ts`. The default `GhCliPrProvider` shells out to the `gh`
CLI — no new npm dependencies, credentials in env only, never in the DB,
journal, messages, or logs. Tests use `FakePrProvider`; the suite never
touches the network or a real GitHub.

**Budgets stay columns.** `plan_rounds` and `cycles` increment
transactionally with the state changes they bound (Phase 0 law). New
`bureau_meta` keys: `review:plan_rounds_ceiling` (default 3) and
`pr:base_branch` (default `main`).

**One journal door, every act.** Verdicts, rubric refusals, approvals, PR
lifecycle, merges, and prunes are attributed spans. The Senior-as-LLM
verdicts carry `actor_role: 'senior-engineer'` with model attribution
through the Phase 1 choke point; deterministic rubric spans carry
deterministic attribution.

Tests never touch the network, the live `db/bureau.db`, or a real `gh`; they
use temp paths and clean up. Every PR names the guard it broke and the test
that caught it: real mutation evidence, appended to
`docs/mutation-evidence-phase4.md`.

## 1. Decisions on the rough's open questions

1. **Senior-as-LLM attribution**: yes — same journal door, `senior-engineer`
   role, model-attributed via `callModel`. The scripted mock client (Phase 3
   CX pattern: `setMockClientOverride`) stands in for the Senior model in
   tests and demos; zero real model calls in the suite.
2. **gh CLI vs. hand-rolled API client**: `gh` CLI behind the `PrProvider`
   seam. A hand-rolled API client is out of scope; if `gh` is absent at
   runtime the provider fails loudly with instructions, never silently
   skips.
3. **Approval door, CLI vs. local page**: CLI now (`scripts/approve.ts`).
   The CDP-dogfooded local page joins the Phase 5 dashboard work; the seam
   (`approveTask`) is identical either way.

## 2. Model roster for this phase

| Role | Backend | Cost |
|---|---|---|
| Senior plan/work review, junior dispatch decisions | Existing Phase 1 choke point (Ollama/Gemini), overridden by the mock client in tests | per token |
| Rubric checks, approval door, PR plumbing, prune | Pure TypeScript | free |

One optional `scripts/smoke_senior.ts` exercises a real Senior model the way
`smoke_llm.ts` does, outside the suite. The junior dispatch prompt is
formalized (system prompt + JSON decision schema, still mock-scripted in
tests); real prompt tuning beyond that stays with Phase 4 DX only as
template structure, not model calls.

## 3. Milestone D0 — contract freeze (half a day, blocks both streams)

One PR into main, both juniors review, then freeze:

- **New job kinds** (`engine/contract/constants.ts`): `senior.review-plan`,
  `senior.review-work`, `pr.create`, `pr.merge`.
- **New span kind**: `review` (added to `SPAN_KINDS`; the journal door
  validates it).
- **Seam extension** (`engine/contract/types.ts` + workspace-seam):
  `WorkspaceProvider` gains `prune(db, taskId)` — post-merge worktree
  removal; `FakeWorkspaceProvider` and `GitWorkspaceProvider` both implement
  it in D0 so neither stream blocks on the other.
- **New seam** (`engine/contract/pr-seam.ts`): `PrProvider` with
  `pushBranch`, `createPr(input) → { url, number }`, `mergePr(number)`,
  plus the `setPrProviderOverride` / `getPrProvider` /
  `getPrProviderOverride` triple; default-unset throws (house pattern).
- **Schema** (`engine/db/schema.ts`): `bureau_work_reviews.reviewed_commit
  TEXT` via `ADDED_COLUMNS` (the verdict-hash law's storage); no new tables —
  `bureau_plans`, `bureau_plan_reviews`, `bureau_work_reviews`,
  `bureau_tasks.pull_request_url` / `merged_at` / `merged_by` already exist
  from Phase 0.
- **Meta keys**: `REVIEW_PLAN_ROUNDS_CEILING: 'review:plan_rounds_ceiling'`,
  `PR_BASE_BRANCH: 'pr:base_branch'` in `BUDGET_META_KEYS`' style under a
  `REVIEW_PR_META_KEYS` block, defaults exported as constants.
- **Contract tests** (`test/unit/contract_d0.test.ts`): migration from a
  Phase 3 database (old `bureau_work_reviews` gains the column, rows
  survive), seam override semantics for both seams, `prune` present on both
  providers, new kinds validated by the journal door.

## 4. Stream A — Senior review gates (Junior A: `engine/review/`)

| # | Deliverable | Acceptance |
|---|---|---|
| A1 | `senior.review-plan` job: deterministic rubric (branch named, scope enumerable, tests and mutations named, walkthrough planned) refuses with a `guardrail` span before any model call; then one choke-point model call (mock in tests) returns `approved` or `amend` with feedback; verdict written to `bureau_plan_reviews`, `review` span journaled, `plan_rounds` incremented transactionally; amendments loop back to the junior, exhaustion (meta ceiling, default 3) blocks the task and notifies the operator | T39, T40 |
| A2 | `senior.review-work` job: deterministic preconditions first — task's `verifier_exit_code = 0`, worktree clean, walkthrough claims present, mutation evidence appended; refusal is a `guardrail` span, no model call; then model rubric over the diff; verdict row records `reviewed_commit` = branch tip at review time; re-review required after any new commit | T41 |
| A3 | Junior dispatch prompt formalized: system prompt + JSON decision schema versioned in `engine/review/junior_prompt.ts`, consumed by the Phase 3 dispatch loop; mock-scripted in tests, no behavior change to CX paths | covered by T45 |

## 5. Stream B — operator door & delivery (Junior B: `engine/delivery/`, `scripts/`)

| # | Deliverable | Acceptance |
|---|---|---|
| B1 | Approval door CLI (`scripts/approve.ts`): lists `needs-review` tasks with verifier exit codes, verify-run counts, plan/work verdicts (with hashes); approval requires typing the task id and `CONFIRM`; writes only through `approveTask`; journals a `human` span; refuses verifier ≠ 0; idempotent | T42 |
| B2 | `pr.create` job: pushes the worktree branch via the workspace seam, opens the PR through `PrProvider` with a body citing the work-verdict hash, records `pull_request_url`; refuses (clean `DeliveryError` + `guardrail` span) without both an approved work verdict for the current tip and recorded operator approval | T43 |
| B3 | `pr.merge` job: inside one transaction re-reads the branch tip and re-checks verdict-hash, approval, and verifier exit 0; merges via `PrProvider`, sets `merged_at`/`merged_by`, transitions the task to `done`, prunes the worktree through the seam; any failed precondition fails the job cleanly with a journaled refusal | T44 |

## 6. Milestone DX — integration & exit demo (both)

Merge order: D0 → A1–A3 → B1–B3 → DX. The full loop runs against a
temporary repository fixture (init a real git repo in a temp dir as the
task's "main"), the mock Senior, the scripted junior from Phase 3's harness,
and `FakePrProvider`.

Exit tests (`test/integration`, numbering continues from T38):

- **T39** — plan review: rubric refusal happens before the model (guardrail
  span, zero `llm` spans); a passing plan earns a model verdict with
  `senior-engineer` attribution; `plan_rounds` increments in the same
  transaction as the verdict row.
- **T40** — plan rounds exhaustion: at the ceiling the task blocks, the
  operator is notified, and further review jobs refuse.
- **T41** — work review gate: refuses when `verifier_exit_code ≠ 0` with no
  model call; verdict records the exact tip hash; a new commit after review
  invalidates the verdict for merge purposes.
- **T42** — approval door: lists the facts; approval flows only through
  `approveTask` (journaled `human` span, idempotent); refuses verifier ≠ 0.
- **T43** — `pr.create`: fake provider receives branch, title, and a body
  citing the verdict hash; `pull_request_url` recorded; refusals without
  verdict-for-tip or approval are journaled guardrails.
- **T44** — `pr.merge`: happy path merges, marks `merged_at/by`, transitions
  to `done`, and prunes the worktree; the unapproved path and the
  wrong-hash path both refuse inside the transaction, leaving no merge and
  no prune.
- **T45** — end-to-end: file → plan → review rounds (mock Senior, one amend
  then approve) → dispatch (Phase 3 harness, scripted junior) → verify →
  work review → approve → PR (fake) → merge → pruned → `done`; journal
  chain complete and attributed end to end, zero fail spans on the happy
  path.
- **T46** — `npm run demo:phase4` mirroring the Phase 2/3 demos: temp
  everything, mock Senior, fake PR provider, printed journal timeline, exit
  0, zero leaked processes.

## 7. Explicitly out of scope for Phase 4

Watchdog, backup push automation, Secretary, dashboards and the CDP
-dogfooded approval page, the red-team sweep (Phase 5); real GitHub
operations inside the suite; real model calls inside the suite; any change
to the done CHECK (it already enforces the invariant — Phase 4 builds doors
up to it, not around it); Phase 5's flake hardening.
