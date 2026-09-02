# Senior verdict — N15 senior-stall resilience (bounded retry + re-armable blocked)

- **Task:** `1ac387ee-d280-4960-be39-3588b628d568` ("N15: make flow senior reviews survive a transient claude CLI stall")
- **Branch:** `bureau-wt-1ac387ee-d280-4960-be39-3588b628d568` (tip `aa10257`, single checkpoint commit)
- **Base:** `847bf43` (main tip)
- **Senior:** zai (ZCode/GLM-5.3), acting senior under operator delegation this session — the claude CLI senior is out of credits (session limit), so the operator pinned senior duty here. Reviewed directly (full diff read + suite + mutation re-execution), not via the CDP review harness.
- **Kind:** phase4 (code-diff review) at the branch tip — deliberately: the flow's gating review was a `walkthrough`-phase review at the same tip (`aa10257`), and per the N2 discipline the delivery gate should be a phase4 diff review at the tip. This review is that review.
- **Date:** 2026-09-02
- **Verdict:** **APPROVE**

## What was reviewed

The 2026-09-01 incident: the runner's `work.cycle` senior review died terminally ("Claude
CLI senior stalled: no output for 300s") while the same senior was driven manually in
parallel; `work.cycle` is single-attempt, so task `0e921cfa` (N11) stranded at `claimed`
with a dead job. The fix: both in-flow senior-review call sites
(`engine/flow/plan_review_cycle.ts`, `engine/flow/work_review_cycle.ts`) wrap
`senior.review(...)` in a bounded retry loop — budget from env `SENIOR_STALL_RETRIES` /
meta `senior:stall_retries`, default `DEFAULT_SENIOR_STALL_RETRIES = 2` (i.e. 3 total
attempts). Every retry journals a `senior_review_retry` guardrail span; retries start a
fresh senior conversation (`freshConversation: true` on attempt > 1) to clear stuck
conversation state. On exhaustion the task transitions to `blocked` (senior-engineer
attribution; plan-cycle does the legal two-hop `queued → claimed → blocked`, work-cycle
`claimed → blocked`), journals `senior_stall_exhausted`, notifies the operator, and the
cycle returns a new `{ outcome: 'blocked' }` result — the job completes, the task is
re-armable via `rearmTask`. Verdict semantics (parseVerdict, phantom-verdict guard,
attribution, done-gate) untouched.

## Independent verification (this senior, this session)

- **Diff read in full** (5 files, +614/−34): both cycles mirror each other; loop
  arithmetic hand-checked — `maxRetries=2` → calls at attempts 1,2,3 with exhaustion at
  `attempts=3` (1 + 2 retries); `maxRetries=0` → single attempt then exhaustion. No
  partial/echoed output is ever recorded as a verdict; the fail-closed catchers are
  upstream of the retry (a stall throws before any review row is written — proven by the
  exhaustion test asserting zero `bureau_work_reviews` rows).
- **`tsc --noEmit` clean; full suite 683/683 across 124 files green** in the worktree —
  matches the walkthrough's claim exactly.
- **Tests are genuine, not hollow** (`test/integration/tc_senior_stall_resilience.test.ts`,
  6 tests): transient N−1-stalls-then-success for BOTH cycles (verdict recorded exactly
  once, correctly attributed); always-stall exhaustion for work (from `claimed`) and plan
  (from `queued` two-hop AND from `claimed`) — each asserting the `blocked` state, exactly
  one `senior_stall_exhausted` guardrail span with attempts/senior fields, the operator
  notification, zero review rows (fail-closed), and `rearmTask` recovery re-enqueuing the
  right cycle kind as a pending job; plus the `freshConversation` initial/retry semantics.
- **Mutation M-N15a re-executed live by this senior** (the dept's law — claims are
  re-run, never trusted): `const maxRetries = 0` substituted in
  `work_review_cycle.ts` → 3 tests FAILED (`work.cycle transient stall recovery` expected
  `approved` received `blocked`; `work.cycle stall exhaustion … rearmable` — attempts/calls
  counts; `re-review continuation … freshConversation`) — the budget guard has real
  catchers. Restored → 6/6 green; `git status` clean, tip still `aa10257`.

## Notes (non-blocking, on the record)

1. **The retry attempt counter is in-memory, not a persisted transactional column** (the
   spec's "incremented transactionally like the other budget columns" phrasing). The
   load-bearing properties hold regardless: the budget is bounded per cycle invocation,
   every retry is journaled, and exhaustion is a transactional state transition (not a
   counter). A process CRASH mid-cycle still dies as a dead single-attempt job (no blocked
   transition fires) — that residual is N12's infra-retry territory, not N15's.
2. `readSeniorStallRetries` is duplicated across both cycle files (the work-cycle copy is
   exported, the plan-cycle copy is private) — minor; a shared helper would be cleaner.
3. The catch retries ANY `senior.review` exception (stall, subprocess failure,
   uncaptured-review refusal) — matches the spec's "stalled or failed senior call"; a
   deterministic non-transient error burns the budget then blocks. Wasteful but fail-safe.
4. Callers tolerate the new `blocked` outcome (the cycles' only production caller is the
   job registry, which treats the result as completion; suite × 683 confirms).

## Evidence

- Suite: 683/683 across 124 files, green (this senior's own run in the worktree).
- `tsc --noEmit` clean.
- M-N15a re-executed live (3 real failures caught, restored green) — recorded above and
  consistent with `docs/mutation-evidence-phase8.md` M-N15a/M-N15b.
- Gating pipeline evidence (pre-existing): staged `verify.run` exit 0; walkthrough review
  `approved` at `aa10257`; `reviewed_commit == tip == aa10257`.

**APPROVE.** Delivery gate satisfied by this phase4 review at the tip.
