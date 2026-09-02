# Walkthrough — N3: wire the junior assignment policy into every flow door

**Branch:** `wt/junior-a-n3-junior-assignment` · **Tip:** `66f64c4` ·
**Base:** `d9b8152` (= origin/main at cut time) · **Date:** 2026-09-01

Plan: `docs/plan-n3-junior-assignment.md`. Source item: N3 in
`docs/plan-pre-phase8-remaining.md` §2026-08-30 session findings; ledger
"NEXT INSTANCE — START HERE" item (1).

## The defect (verified, not inferred)

`assignJunior({ taskId })` (`engine/harness/antigravity.ts:138`, deterministic
hash → A/B) had **zero production callers** — `grep -rn assignJunior engine/
scripts/` returns only its definition (tests aside). The auto-kickoff chain
enqueues `plan.cycle` with `{ taskId }` and no junior
(`engine/filing/file_task.ts:113`, same in `reconcile.ts` / `rekick.ts`), and
the cycles resolved the missing junior with a hardcoded fallback
`(opts.junior || 'A')` — so `'A'` was the de-facto policy. The first
2-concurrent run (2026-08-30) dispatched BOTH `3756ec6e` and `b55e2fda` to
junior A; one window/chat, cross-contamination. The senior side was already
wired (`assignSeniorForTask` at `plan_review_cycle.ts:363`,
`work_review_cycle.ts:219`) — only the junior half was missing.

With the run's real full UUIDs, the policy gives `b55e2fda-…` → **B** and
`3756ec6e-…` → **A** (verified by executing the hash): the split N3 predicted.

## What changed (5 files, +250/−4)

1. `engine/flow/plan_review_cycle.ts:278` — `juniorId = (opts.junior ||
   assignJunior({ taskId: task.id })).toUpperCase()`. The resolved id already
   propagates: into the implementation dispatch payload
   (`jr.junior ?? juniorId`), the next `plan.cycle` round (`junior: p.junior`),
   and via `dispatch-job.ts`'s chained `work.cycle` (`payload.junior`).
2. `engine/flow/work_review_cycle.ts:396` — the REVISE fix dispatch uses the
   same fallback.
3. `engine/verify/loop.ts:100` — the N1(b) stale-approval re-review enqueues
   `work.cycle` with `junior: assignJunior({ taskId })` pinned explicitly
   (self-describing payload). The verify-FIX sendback's `verify.run` re-enqueue
   deliberately does NOT carry a junior (the verifier drives no junior).
4. `test/integration/tc_junior_assignment.test.ts` — 6 tests (below).
5. `docs/mutation-evidence-phase8.md` — M-N3a/b/c recorded.

Overrides intact: explicit `opts.junior` (CLI `--junior`, rekick pin, chained
payloads) and `JUNIOR_DEFAULT` still win over the hash. The
`file_task.ts` comment ("the cycle itself defaults its junior/senior from the
assignment policy") was aspirational before and is now literally true — unchanged.

## Tests

- fixture guard: the two run ids hash to A and B respectively
- plan cycle unpinned → driver receives **B**, dispatch payload `junior: 'B'`
- work-cycle fix dispatch unpinned → fix payload `junior: 'B'`
- stale-approval re-review → `work.cycle` payload `junior: 'B'`, state `claimed`
- **N3 regression**: both tasks driven → `Set{ 'A', 'B' }` (no shared junior)
- pinned junior still wins (`junior: 'A'` on a B-hashing task → drives A)

All tests clear `JUNIOR_DEFAULT` (save/delete/restore) so the deterministic
split is what runs.

## Claims (re-runnable)

- `npx vitest run` → **660/660 across 121 files** (was 654/120 on main),
  green in two consecutive full runs. One earlier run had a single failure
  that did not reproduce (name not captured — the documented intermittent
  `t4` parallel-load flake class; `t4_crash_resume` passes in isolation 3/3).
- `npm run build` (`tsc --noEmit`) → clean on the branch tip.
- Mutations (each applied to the real code, watched fail, restored):
  - **M-N3a** plan cycle → `|| 'A'`: 2 failures —
    `expected 'A' to be 'B'` (plan-cycle + dispatch payload) and
    `expected Set{ 'A' } to deeply equal Set{ 'A', 'B' }` (split regression).
  - **M-N3b** work-cycle fix dispatch → `|| 'A'`: 1 failure —
    `expected 'A' to be 'B'`.
  - **M-N3c** verify/loop re-review payload drops `junior`: 1 failure —
    `expected undefined to be 'B'`.

## Untouched (deliberately)

- N0 (junior completion race) — the other concurrency P0, needs a live run.
- No chosen-junior DB column — deterministic-by-id makes it redundant.
- The window-lease scoping (`window-${junior}`) already merged with b55e2fda.
