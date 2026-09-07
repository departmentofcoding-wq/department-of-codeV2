# Senior verdict — C5: centralized verdict vocabulary + zai reply-chrome hygiene

**Verdict: APPROVE** · **Senior:** claude (Claude Code CLI) · **Model:** claude-opus-4-8 · **Date:** 2026-09-07

Re-applies task C5 (3c8e4a65 / re-filed d905cbec) onto current main — its junior work was
uncommitted in an old worktree that conflicted with the recent senior.ts changes, so the substance
was re-applied cleanly.

## Verified (no behavior change — the load-bearing claim)
- `Verdict` is a strict `'approve' | 'revise'` union, so `normalizeVerdict(review.verdict)` in the
  diff/work cycles receives only `approve→approved` / `revise→amend` — bit-for-bit identical to the
  old inline ternary; the `unknown`/`null` branches are unreachable from those sites.
- `plan_review_cycle`: `normalizeVerdict(review.verdict) === 'approved'` ⇔ old `=== 'approve'`.
- `narrate.ts`: normalizing collapses the old `'revise' || 'amend'` pairs to `=== 'amend'`, and stays
  backward-compatible with legacy journal rows that stored raw `'revise'`. The surviving
  `action === 'approve'` is the human-operator branch (different semantics) — correctly untouched.
- `stripSeniorReplyChrome` wired into `ZCodeSenior.review` BEFORE the guards/parse; since the system
  prompt forces replies to begin with `VERDICT:`, over-stripping isn't a real risk, and a test pins
  that internal "Copy this snippet" text survives. All-chrome collapses to `''` → parseVerdict
  fail-closes to revise (prior behavior).

## Minor (non-blocking, follow-up)
`normalizeVerdict`'s `FlowVerdict | string` return widens away the literal type for the cycles'
`verdict`; harmless (only `=== 'approved'` downstream), but a tighter signature would preserve
narrowing for future callers.

## Operator-side verification
tsc `--noEmit` clean; full suite green (exit 0); unit tests for normalizeVerdict + stripSeniorReplyChrome.
