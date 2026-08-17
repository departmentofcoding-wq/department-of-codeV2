# Phase 4 (rough) — Senior Review, Gates, and Delivery

Rough outline for planning; not yet a frozen plan. Numbering, tables, and
tests get decided when Phase 3 exits. Schema note: much of the groundwork
already exists — `bureau_plans`, `bureau_plan_reviews`, `bureau_work_reviews`
(Phase 0), `bureau_dispatches` (with `ide_model`, `pull_request_url`,
`merged_at/by`), `needs-review → done` gated to human-operator, and
`approveTask` as the single writer for approval.

## Scope sketch

- **Senior Engineer as software**: a senior-officer over the Phase 1 LLM
  choke point that reviews junior plans and work using a fixed rubric;
  verdicts written to `bureau_plan_reviews` / `bureau_work_reviews` with
  full attribution. Deterministic rubric checks (tests exist, mutation
  evidence cited, scope respected) run before any model call — the cheap
  gate first.
- **The review loop as jobs**: `senior.review-plan`, `senior.review-work`
  job kinds; review rounds bounded by the `plan_rounds` / `cycles` budget
  columns, incremented transactionally as Phase 0 laid down.
- **Junior prompts tuned for real work**: the scripted mock from Phase 3's
  CX becomes a real junior prompt over the harness; budget columns bound
  attempts.
- **Operator approval door**: a small CLI (or minimal local page) listing
  `needs-review` tasks with verifier exit codes, run rows, and diffs;
  approval goes through `approveTask` — there is and remains no other
  writer for `approved_at`.
- **PR creation and merge**: from the task's worktree branch — push branch,
  open a PR (gh CLI or git + API), record `pull_request_url`; merge only
  after verifier exit 0 AND operator approval (the done CHECK already
  enforces this in the DB); on merge, prune the worktree through the Phase
  2 seam and mark `merged_at/by`.
- **Exit sentence (draft)**: a junior's plan and work are reviewed by a
  Senior with a rubric and budgets; the operator approves through the one
  approval door; the PR is created from the task's worktree and merged only
  when the DB agrees; and the worktree comes home pruned.

## Open questions

- Where does the Senior's own verdict live when the Senior is also an LLM —
  same journal door, `senior-engineer` role, model-attributed? (Probably
  yes; the attribution tuple already supports it.)
- gh CLI availability vs. hand-rolled GitHub API client (keys in env only).
- How much of the approval door is CLI vs. local web page served by the
  engine (CDP harness could dogfood it).
