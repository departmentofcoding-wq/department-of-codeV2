# Plan — N3: junior-B bypassed; auto-kickoff hardcodes junior A

**Status:** implemented on `wt/junior-a-n3-junior-assignment` (tip `66f64c4`, 2026-09-01):
3 sites wired + 6 tests (`tc_junior_assignment.test.ts`) + mutations M-N3a/b/c recorded
(`docs/mutation-evidence-phase8.md`); suite 660/660 ×2, `tsc` clean. Walkthrough:
`docs/walkthrough-n3-junior-assignment.md`. Awaiting senior verdict → operator merge. ·
**Priority:** P0 (gates any ≥2-task concurrent run) ·
**Source:** `docs/plan-pre-phase8-remaining.md` §N3, ledger "NEXT INSTANCE — START HERE" item (1).

Investigative item — no live GUI needed to start. This doc records the root cause
(fully traced in code, not inferred) and the fix.

---

## Root cause — confirmed in code

The deterministic assignment policy `assignJunior({ taskId })`
([antigravity.ts:138](../engine/harness/antigravity.ts:138)) exists and is unit-tested
([tc_antigravity.test.ts:129](../test/unit/tc_antigravity.test.ts:129)) — but it has
**zero production callers**. Grep for `assignJunior` across `engine/ scripts/ console/`
(excluding tests) returns only its own definition.

The auto-kickoff flow never invokes it. The chain:

1. [file_task.ts:111](../engine/filing/file_task.ts:111) enqueues `plan.cycle` with
   payload `{ taskId }` — **no `junior` field**. Its own comment claims "The cycle
   itself defaults its junior/senior from the assignment policy" — but that is not what
   the cycle does.
2. [registry.ts:383](../engine/jobs/registry.ts:383) parses the payload (`junior`
   optional, absent) and calls `runPlanReviewCycle(db, { taskId, ... })` with `junior`
   still `undefined`.
3. [plan_review_cycle.ts:276](../engine/flow/plan_review_cycle.ts:276):
   `const juniorId = (opts.junior || 'A').toUpperCase();` — **hardcodes `'A'`**. This is
   the bug: the `|| 'A'` fallback stands in for the assignment policy that was supposed
   to run here.

So **every** auto-kickoff task routes to junior A. In the first 2-concurrent run both
`3756ec6e` and `b55e2fda` landed on A, sharing one window/chat, and cross-contaminated.

The same hardcoded fallback appears at two more leak points that must be fixed together
or the task can still flip juniors mid-flow:
- [work_review_cycle.ts:392](../engine/flow/work_review_cycle.ts:392):
  `junior: (opts.junior || 'A').toUpperCase()` (the verify/walkthrough fix dispatch).
- [verify/loop.ts:93](../engine/verify/loop.ts:93): re-enqueues `work.cycle` with
  `{ taskId }` only — no junior — so a stale-approval re-review would also default to A.

The chained work.cycle from a successful dispatch already carries the junior forward
([dispatch-job.ts:380](../engine/harness/dispatch-job.ts:380):
`...(payload.junior ? { junior: payload.junior } : {})`), so once the *source* choice is
correct it propagates through the happy path. The two leak points above are the paths
that don't inherit it.

### Why this is the whole story (not `JUNIOR_DEFAULT`)

The ledger hypothesized a runner env default (`JUNIOR_DEFAULT=A`) or a pinned rekick
payload. Neither is needed to explain it — `assignJunior` honors `JUNIOR_DEFAULT`
(antigravity.ts:140) but is never called, so any env would be moot anyway. The defect is
purely that the policy is unwired and `|| 'A'` is the de-facto policy. (Worth a one-line
confirm that the runner has no `JUNIOR_DEFAULT` set, so the deterministic split is what
runs — but it is not the cause.)

### Fix validated against the real run

With the real full task UUIDs (the `docs/junior-artifacts/` folder names):
`assignJunior('b55e2fda-5309-…')` → **B**, `assignJunior('3756ec6e-4ee5-…')` → **A**.
So wiring the policy in would have split the two tasks across A/B exactly as N3 predicts —
no shared window, no contamination. (The truncated 8-char ids both hash to A; the engine
always uses full ids, matching the artifact folders.)

---

## The fix

Make `assignJunior(task.id)` the fallback everywhere the junior is currently defaulted to
`'A'`. Because `assignJunior` is deterministic by task id, every path (plan cycle, work
cycle, verify re-review, fix dispatch) converges on the **same** junior for a given task
with no need to persist a chosen-junior column — the id is the source of truth.

1. **`engine/flow/plan_review_cycle.ts:276`** — replace
   `const juniorId = (opts.junior || 'A').toUpperCase();`
   with `const juniorId = (opts.junior || assignJunior({ taskId: task.id })).toUpperCase();`
   (import `assignJunior` from `../harness/antigravity.ts`).
2. **`engine/flow/work_review_cycle.ts:392`** — same substitution for the fix-dispatch
   `junior` field, keyed on the task id in scope.
3. **`engine/verify/loop.ts:93`** — either leave as-is (the downstream work.cycle will now
   resolve deterministically via #2) or pass `junior: assignJunior({ taskId })` explicitly
   for symmetry. Prefer explicit — it keeps the payload self-describing in the journal.
4. **`engine/filing/file_task.ts:107`** — fix the misleading comment (or, optionally, set
   `payload.junior` at enqueue so the choice is visible in the `plan.cycle` payload/journal
   from the start). Setting it at enqueue makes the assignment auditable in one place;
   defaulting inside the cycle keeps the payload minimal. **Recommendation:** default inside
   the cycle (single source of truth, matches how the rest of the fallback works) and just
   correct the comment.

`prefer` / explicit `opts.junior` / `JUNIOR_DEFAULT` all still win over the hash, so an
operator can still pin a junior — the change only replaces the silent `'A'` with the
deterministic spread when nothing is specified.

---

## Tests (add before merge)

- **Unit — plan cycle honors assignment.** With no `junior` in opts, `runPlanReviewCycle`
  drives the junior `assignJunior({ taskId })` returns (assert the driver received that
  junior). Use a task id that hashes to **B** so the test fails against the current
  `|| 'A'` and passes after the fix. Mirror for `runWorkReviewCycle`'s fix dispatch.
- **Regression — two concurrent tasks split.** Two task ids that hash to A and B (e.g.
  the run's own `3756ec6e-…`/`b55e2fda-…`) drive two different juniors — the exact N3
  scenario, locked in.
- **Mutation M-N3.** Reverting the fix to `|| 'A'` must turn a test red. Record in
  `docs/mutation-evidence-phase8.md`.
- Full suite + `tsc --noEmit` green.

## Out of scope (tracked elsewhere)

- N0 (junior completion race) — the other concurrency P0; needs a live run. N3 is the
  *assignment* half, N0 the *completion* half; b55e2fda's own merged fix
  (`window-${junior}` lease scoping) is the *window* half. All three are needed before an
  honest ≥2-task run, but N3 is self-contained and testable offline.
- Persisting a chosen-junior column — unnecessary given deterministic-by-id; explicitly
  not doing it.

## Sequencing / delivery

Engine-dev change: branch → claude-senior review → `--no-ff` merge to local main →
re-verify (suite + tsc) → push is the operator's call. Small blast radius (three
one-line substitutions + a comment + tests). Land before N0 and before any ≥2-task run.

## Senior review — status (2026-09-01) and how to finish it

The branch (`66f64c4`) is review-ready but **no valid senior verdict exists yet**;
per the merge law it stays un-merged. Two attempts, both fail-closed:

1. **claude CLI senior — BLOCKED (operator action needed):** `claude -p` fails
   "OAuth session expired and could not be refreshed"; no `ANTHROPIC_API_KEY` in
   env (only `ANTHROPIC_BASE_URL`). Fix: a human runs the `claude` login flow,
   then re-drive the review (the prepared review prompt is embedded below).
2. **zai/ZCode senior — INVALID, do not retry from inside ZCode:** port 9335 is
   currently the ZCode instance hosting the *working session itself*, so
   `run_senior --senior zai` attached to the session's own window and scraped
   its own transcript (the capture shows the session's own tool calls). Circular
   self-review — and the scraped text contains the literal string
   "VERDICT: APPROVE" (echoed from the review prompts the session built), so a
   parseVerdict on it could FALSE-APPROVE. **Any "verdict" printed by that run
   is void.** The zai path is only valid from a dedicated senior ZCode instance
   on 9335 that is not the session doing the work (the existing
   circularity-avoidance rule).

**Incident note for the punch list (candidate N10):** `run_senior --senior zai`
has no guard against attaching to a ZCode instance that is not the senior (a
busy/foreign window on 9335) — the capture path can slice a foreign transcript
and `parseVerdict` can match verdict markers in *echoed prompt text*. Same class
as the phantom-verdict guard's purpose; the window-identity check deserves
hardening.

**To finish (operator):** re-auth claude, then from the repo run the equivalent
of the N8 review — `claude -p --append-system-prompt "<senior system>"` with a
review prompt containing: the N3 task verbatim (§N3 of
`docs/plan-pre-phase8-remaining.md`), the walkthrough
(`docs/walkthrough-n3-junior-assignment.md`), and instructions to verify
independently (git diff d9b8152..66f64c4; close-read the three sites; grep
`assignJunior` on the base for zero callers; judge
`test/integration/tc_junior_assignment.test.ts`; re-run the new test file +
`tsc --noEmit`; hunt unlisted defects). Post the verdict to
`docs/reviews/verdict-n3-junior-assignment.md`, then `--no-ff` merge
`wt/junior-a-n3-junior-assignment` (`66f64c4`) to local main, re-verify
(suite ×2 + tsc), and update the ledger. Push is the operator's call.
