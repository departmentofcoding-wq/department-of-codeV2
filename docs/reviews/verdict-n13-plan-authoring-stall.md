# Senior verdict — N13: plan authoring must not arm the N0 completion-sentinel gate

- **Branch:** `wt/n13-plan-authoring-stall` (tip `cf655b3`)
- **Base:** `main` (origin `216b2bb`)
- **Senior:** claude (Claude Code CLI, `claude -p --append-system-prompt`, adversarial close-read)
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-01
- **Verdict:** **APPROVE**

## What was reviewed
`buildJuniorPlanPrompt` no longer appends `JUNIOR_COMPLETION_INSTRUCTION`, so the
plan-authoring prompt lacks `BUREAU-JUNIOR-COMPLETE` and the driver's N0 completion-evidence
gate stays DISARMED for authoring (idle+stable completion — the proven pre-N0 behavior). The
sentinel stays on `buildImplementationPrompt`, `buildFixPrompt`, and `buildVerifyFixPrompt`
where the subprocess race is real. Test in `tc_plan_cycle.test.ts` inverted (authoring prompt
must NOT contain the marker, both round-1 and revise-round); implementation/fix assertions
retained. Mutation M-N13 recorded.

## Root cause (live-diagnosed)
Filed engine-dev tasks N9/N10/N11 died in plan authoring with "no progress for the stall
window" (4 stalls vs 1 success). Live observation (junior A, Gemini 3.7 Flash Medium): the
agent explores the real codebase for minutes with a reliable "Working…" indicator, then writes
a plan. Because authoring armed the marker gate, an agent that finished WITHOUT echoing the
exact marker line went idle+stable-but-markerless → the 5-minute `evidenceTimeoutMs` fired →
`'stalled'` → the authored plan was DISCARDED and `plan.cycle` died. Marker emission is
LLM-nondeterministic, hence intermittent. **Honest caveat carried into review:** across three
controlled observations the authoring COMPLETED (marker emitted at 25–122s); the intermittent
stall itself was NOT directly reproduced — the diagnosis is mechanistic + circumstantial.

## Senior's findings (verbatim summary)
- **Scoping correct and complete:** `buildJuniorPlanPrompt` is the only prompt that lost the
  marker; `buildImplementationPrompt`, `buildFixPrompt`, `buildVerifyFixPrompt` all still append
  it; no second plan-authoring prompt builder exists. `git diff --stat` matches the reviewed diff
  (no hidden changes).
- **Tests meaningful:** the inverted assertion covers both round-1 (`p`) and the revise round
  (`p2`); retained `toContain` assertions prove the gate stays armed where N0 needs it.
- **Safety — the load-bearing question:** the "N0 race is implementation-only" claim is an
  *inference* from 3 successful trials, not a structural guarantee (authoring also runs short
  tool calls). BUT residual risk is acceptable, not blocking, because (1) this REVERTS to
  previously-proven behavior — pre-N0 idle+stable ran in production for authoring for months with
  no truncation incidents; (2) a false premature completion must still pass the deterministic plan
  rubric (branch/scope/tests+mutation/walkthrough) before reaching the senior.
- **Strong enough to act on:** a reproducible near-total flow failure (4/5 stalls, pipeline
  blocked) vs a theoretical previously-unobserved regression — acting now is reasonable; requiring
  a live-reproduced stall could take arbitrarily long given the 1/3 intermittency.
- **Softer alternative (follow-up, not a blocker):** keep the gate armed but on `evidenceTimeoutMs`
  fall back to the already-captured `planText` through the rubric instead of discarding — authoring's
  deliverable IS the visible chat text (unlike implementation's file edits). Preserves the N0 safety
  property while removing the discard-on-timeout failure mode.
- **Non-blocking suggestion:** log when authoring completes via idle+stable with a plan that fails
  the rubric shortly after, to detect if the theoretical truncation risk is real in production.

## Independent operator verification
Suite **676/676 across 123 files**, `tsc --noEmit` clean on the branch. M-N13 reproduced
(re-arming the gate → `tc_plan_cycle` fails "expected … not to contain 'BUREAU-JUNIOR-COMPLETE'")
→ restored.

## Follow-up recorded
The senior's softer alternative (fall back to captured plan on evidence-timeout) is logged as
**N14** in `docs/plan-pre-phase8-remaining.md`.
