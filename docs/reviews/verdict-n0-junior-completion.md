# Senior verdict — N0: the junior completion gate (sentinel evidence)

- **Branch:** `wt/junior-a-n0-junior-completion`
  - round 1 tip `1179947` → **REVISE** (defect found, below)
  - round 2 tip `0bd049c` → **APPROVE** (this verdict)
- **Base:** `f00fb53`
- **Senior:** claude (Claude Code CLI, `claude -p --append-system-prompt`,
  independent subprocess; sandbox blocked command execution both rounds, so all
  verification is by close code reading + hand-tracing the algorithms against the
  test fixtures — stated openly in both replies)
- **Kind:** phase4 (engine-dev code-diff review) · **Date:** 2026-09-01

## Round 1 — VERDICT: REVISE (the catch)

The gate's evidence check read through `extractAgentReply`, whose needle is the
whole (multi-line) prompt — structurally unmatchable against single transcript
lines, so it always fell back to the page's last 12 lines, which right after
send IS the echoed prompt: the marker inside the echoed instruction could open
the gate with zero agent output — the exact false-completion N0 exists to close,
silently. Corroborated by the senior with four observations: the codebase knows
the submit→generation race is real (`requireActivityStart`, wired for seniors
only); the correct line-aware tool (`sliceAfterPrompt`) already existed and
wasn't used; the round-1 live observation used a single-line prompt, the one
shape that dodges the bug; no test exercised the real integration.

### Round-1 required changes (all addressed in round 2)
1. Line-aware reply-region isolation for evidence — done via the pure exported
   `juniorCompletionEvidence` (`sliceAfterPrompt` keys off the prompt's LAST line).
2. A realistic multi-line just-echoed-prompt test asserting the marker is NOT
   found — done (+4 tests incl. the no-marker b55e2fda shape + fallback case).
3. `requireActivityStart` for juniors OR explicit justification — justified in
   the walkthrough (fast junior replies with no working indicator would
   false-stall; the marker gate covers the front gap for sentinel-carrying
   prompts, which the senior verified are ALL production junior sends).
4. (Nice-to-have) live re-observation with a department-shaped multi-line
   prompt — done (`docs/junior-artifacts/n0-observation-run5-gate.log`:
   ~80s of awaiting-evidence held through the real subprocess gap, completed
   only at the true marker, t=126s). Minor artifact-filter point — adopted.

## Round 2 — VERDICT: APPROVE (verbatim summary)

- The core fix is real and correctly targets the round-1 defect;
  `sliceAfterPrompt`'s last-line backward search is a pre-existing, already
  relied-upon technique (senior.ts, captureArtifacts), not a novel path; the
  instruction is literally the last thing appended at all three production
  prompt call sites, which makes the fallback reasoning sound for production
  traffic.
- Hand-traced the four new tests against BOTH wirings: they return true under
  round-1's fallback for the echoed/no-marker fixtures (the bug) and false
  under round 2 — "not decorative; they would genuinely have failed under
  round-1 wiring." Independently re-derived mutation M-N0c's two failures,
  corroborating the recorded evidence rather than trusting it.
- The run5 live log is genuine and informative; the observed agent-quote-after-
  marker residual is verified FAIL-CLOSED (slice-past-marker → evidence false →
  awaiting-evidence → loud `stalled` at 5 min via ensureCompleted — never a
  silent false-open).
- Confirmed via grep that `plan_review_cycle.ts`/`work_review_cycle.ts` are the
  only production junior-prompt senders and both always carry the sentinel —
  the sentinel-less carve-out leaves no production gap.
- One documentation nit, NOT blocking: the walkthrough's pointer to this very
  verdict doc was written before the doc existed (fixed by creating this file).

**No further changes required for this branch to ship.**

## Independent verification record
- Round 2 suite claim cross-checked by hand-tracing; mutations M-N0a/b/c
  re-derived independently by the senior. Operator re-ran the suite live:
  668/668 across 121 files (one adjacent run 667/668 = the documented t4
  lease-reap flake, 3/3 in isolation), `tsc --noEmit` clean.
