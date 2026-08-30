# Walkthrough — Flow-resilience fix pack, Stream 5: bounded post-merge prune retry

**Branch:** `wt/junior-a-tail-hygiene` · **Tip:** `5a19671` · **Base:**
`main` = `d334004` · **Plan:** `docs/plan-flow-resilience-fixpack.md`
(untracked) · **Status:** NOT merged — awaiting senior verdict.

## The defect (evidence, live DB journal #803)

After the PR #3 merge, the post-commit prune of
`.bureau-worktrees/5d29e47b…` failed `EPERM, Permission denied` — the junior
IDE still held the directory. One immediate attempt abandoned it with only a
`status:'warning'` span. Leftover worktree directories accumulate at exactly
the rate Phase 8 plans to multiply tasks.

## Changes

1. **`pruneWithRetry`** (`engine/worktrees/prune.ts`) — pure and injectable
   (prune fn + sleep): one immediate attempt, then one try per delay
   (default `[2000, 10000]` ms), strictly BOUNDED; returns
   `{ok, attempts, lastError?}`.
2. `pr_merge` runs the prune through it; on exhaustion it journals a
   distinct `status:'deferred'` span (with attempts + the fact that the next
   `prepare` adopts/re-prunes the dir — no hand repair) and notifies the
   operator. Transient EPERMs that clear within the window are silent
   successes.

## Claims (re-runnable)

- Suite **588/588 ×2** (runs 2 and 3; run 1 had the known `t4`
  parallel-load flake — documented class); `npx tsc --noEmit` clean.
- New `tc_prune_retry.test.ts` (4 tests): first-try success (zero sleeps);
  transient-failure recovery with the exact backoff schedule asserted
  (`[2000, 10000]`); bounded give-up (`attempts = 3`, lastError carried);
  empty-delays bound (`attempts = 1`).
- **M-PR-1 (real, executed):** retry loop collapsed to the single immediate
  attempt (`for (const delay of [0])`) → 2 failures ("expected
  {ok:false,attempts:1,…} to deeply equal {ok:true,attempts:3}";
  "expected 1 to be 3"). Restored, re-verified.

## For the senior to re-run

`npx vitest run test/unit/tc_prune_retry.test.ts test/integration/t44_pr_merge.test.ts`
(t44 exercises the real prune path through the merge — still green) — then
M-PR-1 via the recorded edit.

## Honest notes

- The retry only helps when the lock clears (window closed, AV scan
  finished); when it never does, the deferral span + the prepare-time
  adoption are the honest answer. Nothing force-deletes a dirty worktree.
- The plan doc's other Stream-5 items are operator acts, not code: the
  legacy stranded rows (`82b97764`, `e489b734`, `33ace9f7`, `e156395d`)
  get archived/completed-tagged from the console (orthogonal tags, zero
  forged `done`), and the one failed ntfy `done` notification
  (`success:false`, journal #824) is a topic-health check.
