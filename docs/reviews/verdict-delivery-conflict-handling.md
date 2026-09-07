# Senior verdict — Delivery conflict handling (classify + freshen-then-merge + hygiene)

**Verdict: APPROVE (round 2)** · round 1 was REVISE (one functional finding, fixed).
**Senior:** claude (Claude Code CLI subprocess, headless) · **Model:** claude-opus-4-8
**Kind:** phase4 code-diff review, driven over `git diff main` (engine/test/runner/.gitignore/.gitattributes)
**Date:** 2026-09-07
**Usage captured (stream-json):** round 1 ~10.6k out / ~$1.54; round 2 ~20.3k out / ~$2.37.

## Scope
The "only the first approved task merges" fix on branch `wt/delivery-conflict-handling`
(base commit `080df89`, plus the round-1 revision): PR1 conflict classification in
`pr_merge.ts`, PR2 hygiene (checkpoint `:(exclude)docs/junior-artifacts` pathspec + `.gitignore`
+ `.gitattributes` union driver for `mutation-evidence-phase*.md`), PR3 the `delivery.freshen`
job + idempotent `pr.create`.

## Round 1 — REVISE (finding fixed)
The dirty-tree guard in `freshen.ts` used `git status --porcelain`, which flags **untracked**
files. Because the engine writes untracked `docs/junior-artifacts/**` into worktrees and non-dept
repos don't inherit this repo's `.gitignore`, freshen would have died `FRESHEN_DIRTY_TREE` on the
first (non-retryable) attempt in exactly the multi-project scenario it exists to recover — the
recovery would never run and the task would strand. `git merge` tolerates non-colliding untracked
files, and `engine/worktrees/primary_guard.ts` already uses `--untracked-files=no` for this reason.
**Fix applied:** both the entry check and the post-abort pristine self-check now use
`git status --porcelain --untracked-files=no`; a new test seeds untracked `docs/junior-artifacts/**`
in the worktree and asserts freshen still proceeds; the existing dirty-tree test was corrected to
use a TRACKED modification (the real dirty class the guard must still catch). Confirmed on-disk that
delivered branches carry 111 artifact files, so the checkpoint exclusion is needed AND the guard was
genuinely broken (contradiction the senior flagged, resolved: both are correct).

## Round 2 — APPROVE
Verified against the codebase: PR1 classification throws non-retryable `PrRefusalError` (dies attempt
1), queues freshen, keeps the generic path retryable (t44 discriminates the two). Non-destruction law
holds — only fetch/merge --no-edit/merge --abort/rev-parse/status/diff; no `-X`, rebase, reset, or
force; conflict → abort → pristine self-check → `FRESHEN_ABORT_UNCLEAN` else. Clean → full
`runStagedVerifier` (semantic-conflict catch) → `work.diff-review` at the new tip (dedup keys on
`reviewed_commit === tip`, so the moved tip re-reviews). Budget 2 via terminal job rows. Idempotent
`pr.create`. Hygiene correct. Verify-run INSERT matches all 18 columns; `task.verify_fixes` valid.
Mutation evidence M-DC1..5 present with captured output (incl. an honest note on a no-op first M-DC2).

## Non-blocking notes (not fixed, tracked)
1. `crypto.randomUUID()` used as a global in `freshen.ts` (works on Node 24, typechecks) vs
   `diff_review_cycle.ts` importing `node:crypto` — style nit.
2. The re-enqueued `work.diff-review` computes `git diff base..HEAD`, which after merging origin/main
   includes all of main's cumulative changes — the phase4 diff is noisier than the junior's delta.
   Delivery still gated correctly; consider a `main..HEAD`/merge-base diff later.

## Operator-side verification
tsc `--noEmit` clean; `tc_delivery_freshen.test.ts` 7/7; full suite run recorded at merge.
