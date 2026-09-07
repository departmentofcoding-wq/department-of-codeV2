# Senior verdict — Dept hardening fix pack (F1–F4)

**Verdict: APPROVE** · **Senior:** claude (Claude Code CLI) · **Model:** claude-opus-4-8
**Kind:** phase4 code-diff review over `git diff main` (engine/runner/test) · **Date:** 2026-09-07

Four fixes from the 2026-09-07 "fix up everything" diagnosis:

- **F1 — quota exhaustion fails loud.** `detectQuotaExhaustion` (pure) throws in both
  `ClaudeCliSenior` and `ZCodeSenior` before `parseVerdict`, so a senior out of quota never
  fail-closes to a phantom amend that burns the review ceiling (the C5/3c8e4a65 false-block:
  5 quota notices recorded as "amends" on a task never coded). Gated on a real VERDICT line so
  a genuine review mentioning "rate limit" in prose is untouched.
- **F2 — freshen union driver on old branches.** Writes `docs/mutation-evidence-phase*.md
  merge=union` to the repo-local, untracked `info/attributes` before the merge, so old branches
  that predate main's tracked `.gitattributes` don't false-conflict on the append-only ledger
  (the C4 blind spot). No working-tree/porcelain/merge-commit effect; idempotent; best-effort.
- **F3 — stale-runner detection.** The runner stamps its git HEAD sha at boot (journal +
  `bureau_meta`) and, once/60s, warns + notifies the operator on drift from current HEAD — a
  stale runner otherwise silently runs the pre-fix `pr.merge` zombie path.
- **F4 — diff-review amend → bounded junior fix.** A diff-review AMEND dispatches a junior fix
  (`chainDiffReview` → re-review at the new tip) instead of only holding; the task stays at
  needs-review (no illegal transition), bounded by `DIFF_REVIEW_FIX_CEILING`, then holds.

## Verified
All four wired into existing scaffolding, invariants preserved: F1 both seniors + VERDICT guard;
F2 correct info/attributes resolution for linked worktrees, post-dirty-check placement; F3
`bureau_meta` upsert valid, throttled, warns once; F4 stays needs-review, `bureau_dispatches`
insert matches the established pattern, `chainDiffReview` consumed durably in
`handleJuniorDispatch`, re-enqueues `work.diff-review`. New pure cores (`detectQuotaExhaustion`,
`isCodeStale`) unit-tested. tsc clean; full suite green (exit 0).

## Minor (fixed post-verdict)
The senior noted F4's ceiling was off-by-one (2 real rounds, "3 exhausted" message overstated).
Fixed: the gate is now `priorAmends <= DIFF_REVIEW_FIX_CEILING` (priorAmends includes the current
row), yielding a true 3 fix dispatches with an accurate exhausted message.
