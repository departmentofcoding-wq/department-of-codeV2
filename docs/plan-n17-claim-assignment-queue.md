# N17 — Claim-time assignment + capacity queue (2026-09-02)

## The incident (operator-observed, journal-proven)

Three tasks were filed through the agent door within 42 seconds
(2026-09-02 12:10:34 → 12:11:16: `cd9ba44d` N9-tidy, `9505f897` journal
narration, `2d1ac42d` README-greet). **All three were claimed instantly** —
filing kicked off `plan.cycle` immediately with no admission control. Two
leased the two junior windows; the third hammered window-B's lease (~150
`window_lease_conflict` guardrail spans at ~4/second). Consequences, all in
the journal (#1397–#2804):

- Two tasks time-sliced **one junior window**: `2d1ac42d`'s REVISE authoring
  round "continued the current conversation" on window-B right after
  `9505f897`'s conversation had been there — prompts landing in the other
  task's conversation, and round-2's `priorFeedback` captured IDE chrome junk.
- `cd9ba44d`'s implementation dispatch died 3× on CDP timeouts; `9505f897`
  burned its senior-stall budget; the operator was already hand-rekicking by
  12:30.
- The operator watched junior B's approved plan handed to a **brand-new
  junior-A session**: an unpinned dispatch payload falls back to
  `window-default` and `resolveJunior(undefined)` = junior A with
  `freshConversation` defaulting true — the exact silent cross-routing this
  change kills.

## The law this change enforces

1. **A task's junior and senior are decided exactly once — at claim — and
   persisted** (`bureau_tasks.assigned_junior/assigned_senior/assigned_at`,
   written transactionally by `ensureTaskAssignment`, journaled as an
   `assignment` span). Every phase reads the pin: plan-authoring rounds,
   implementation dispatch, REVISE fix dispatch, verify-fix dispatch,
   stale-approval re-review, work reviews. The pin is immutable; a payload
   that disagrees is a routing bug (guardrail span, assignment wins).
2. **One task per junior.** A junior is occupied from its task's admission
   until the task reaches `needs-review` / `blocked` / `done` / `failed` or is
   archived. Roster size = capacity = 2 concurrent tasks, by construction.
3. **Filed tasks wait in a FIFO queue.** Filing no longer enqueues
   `plan.cycle`; the queue manager (the evolved reconciler, swept by every
   runner tick) admits the oldest queued unassigned task **only when a junior
   is free** (plus the existing operator-action rule: dead cycles are never
   auto-retried; a needs-review/blocked task frees its junior instantly).
4. **Unpinned dispatches fail loud.** No more `window-default` / junior-A
   silent defaults on the prompt path.
5. **Same context window:** the pinned junior + one-task-per-junior invariant
   means "the current conversation on that window" is always *this task's*
   conversation; flow dispatches keep `freshConversation: false` (plan →
   implement → fix rounds continue one conversation).
6. **The journal is the record:** authoring spans carry the full prompt + the
   reply head/length; review spans carry the senior's full feedback; the
   claim itself is an `assignment` span. (Implementation dispatch observation
   spans already carried prompt + transcript.)
7. **Lease-conflict waits journal once**, not per 250ms poll (the 150-span
   flood class).

## Why the worktree stays lazily prepared

The worktree is created (idempotently, adopt-on-reuse) by the implementation
dispatch, transactionally before the junior is ever pointed anywhere —
preparing 5–6 worktrees for queued tasks that cannot run yet would waste
repo state; the pin (WHO runs it) is what must exist at claim, and it does.

## Components

- `engine/flow/assignment.ts` (NEW): `ensureTaskAssignment`,
  `readTaskAssignment`, `juniorIsOccupied`, `freeJuniors`.
- `engine/flow/reconcile.ts`: queue manager (capacity + FIFO + defer-reset +
  operator-action rule preserved).
- `engine/flow/plan_review_cycle.ts`: entry assignment gate (defer outcome),
  pinned junior/senior, prompt journaled.
- `engine/flow/work_review_cycle.ts`: pin read, mismatch guardrail,
  feedback journaled.
- `engine/verify/loop.ts`: both dispatch sites read the pin.
- `engine/harness/dispatch-job.ts`: pin resolution (assignment wins),
  loud refusal when unpinned, chained work.cycle carries the pin.
- `engine/harness/lease-manager.ts`: conflict journal dedupe on waits.
- `engine/filing/file_task.ts`: kickoff removed (queue manager owns it).
- Schema: 3 nullable `bureau_tasks` columns (ADDED_COLUMNS boot migration);
  `assignment` added to `SPAN_KINDS`.
- Tests: `test/integration/tc_flow_assignment_queue.test.ts` (10), updated
  `file_task`/`tc_agent_file_task`/`tc_dispatch_antigravity`/
  `tc_primary_contamination_guard` fixtures. Mutations M-N17a/b/c.

## Deliberately out of scope

- Senior capacity gating (reviews are short, interleavable, and the pin
  already spreads tasks across seniors; a GUI-senior contention incident
  should be its own finding if it recurs).
- Re-filing the three archived tasks (operator act, after merge).
- N14 (salvage plan on evidence timeout) — still open on the punch list.
