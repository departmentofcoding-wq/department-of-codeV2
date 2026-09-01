# Walkthrough — N0: the junior completion gate (sentinel evidence)

**Branch:** `wt/junior-a-n0-junior-completion` · **Date:** 2026-09-01
Plan: `docs/plan-n0-junior-completion.md` (includes the live-observation record).
**Round 2** — addresses the claude senior's REVISE (verdict text in
`docs/reviews/verdict-n0-junior-completion.md`); changes listed under "Round 2" below.

## The defect (live-reproduced this session)

The department decides a `junior.dispatch` is done when the chat pane is idle+stable
(`waitForAgentIdle`, 2 polls). Live observation on junior A (`scripts/n0_observe.ts`,
log at `docs/junior-artifacts/n0-observation-run4.log`): an agent that ends its TURN
while its own terminal subprocess runs renders **no Stop/Cancel/spinner anywhere in
the DOM** — from t=8s to t=93s the probe read `working=false, canSend=true, len
steady`, and the current rule would have completed at **t=12s** with ~85s of pending
subprocess (the b55e2fda ~38s signature, reproduced). The agent then **resumed on its
own** (t=95) and posted the instructed marker (t=97).

Findings that picked the fix: **C (terminal-busy DOM signal) is dead** — no such
signal exists during the gap (the terminal Cancel control appears only during active
turns). **A (sentinel) is proven** — the agent obeys a final-marker instruction and
the marker lands exactly at true completion. First-hand scar: the marker MUST be
detected only in the reply region (the echoed prompt contains the string; the first
observation run false-matched at t=2s).

## What changed

1. `engine/harness/agent-wait.ts` — `WaitOptions.completionEvidence?: () =>
   Promise<boolean>` + `evidenceTimeoutMs` (default 5 min). At an idle+stable
   would-complete moment with the gate configured: no evidence → keep waiting
   (`awaiting-evidence`), regular stall net disarmed, dedicated timeout → **loud
   `stalled`** (`stalled-awaiting-evidence` onTick status); real activity
   (working/growth) re-arms the evidence clock; evidence → `completed`. Without
   the option, behavior is byte-identical to before.
2. `engine/harness/antigravity.ts` — `JUNIOR_COMPLETION_MARKER`
   (`BUREAU-JUNIOR-COMPLETE`) + `JUNIOR_COMPLETION_INSTRUCTION` (explicitly tells
   the agent a running subprocess means NOT done).
3. `engine/harness/antigravity-seam.ts` — the real driver auto-arms the gate when
   the prompt contains the sentinel (all department-built prompts do): evidence =
   `readAgentReply(prompt)` contains the marker. Arbitrary CLI prompts (no
   sentinel) keep the old behavior — no stranded tasks, backward compatible with
   old queued payloads.
4. `engine/flow/plan_review_cycle.ts` ×2 + `work_review_cycle.ts` ×1 — every
   department junior prompt (plan, implementation, fix) carries the instruction.

## Tests

- `test/unit/tc_agent_wait.test.ts` +3: the b55e2fda shape does NOT complete during
  the gap and completes only after evidence (evidence consulted exactly at the
  would-complete moments); markerless idle fails LOUD via the evidence timeout
  (asserted by onTick status, not just the result); two sub-timeout gaps split by
  activity do not add up to a stall (re-arm).
- `test/integration/tc_plan_cycle.test.ts` +2 assertions,
  `tc_work_cycle.test.ts` +1: all three builders emit the sentinel instruction.

## Claims (re-runnable)

- Round 2: `npx vitest run` → **668/668 across 121 files fully green**; one
  adjacent run showed 667/668 with the single failure being `t4_crash_resume`
  (the ledger-documented intermittent lease-reap flake — passes 3/3 in
  isolation; unrelated to N0). Round 1: 663/663 green twice consecutively.
- `npm run build` (`tsc --noEmit`) → clean (both rounds).
- Mutations (applied to real code, watched fail, restored):
  - **M-N0a** `const evidenced = true` (gate bypassed): 3 failures —
    `expected +0 to be 3`, `expected 'completed' to be 'stalled'`, `expected +0 to be 4`.
  - **M-N0b** instruction dropped from `buildImplementationPrompt`: 1 failure —
    `expected '…' to contain 'BUREAU-JUNIOR-COMPLETE'`.
  - **M-N0c** evidence without the line-aware slice (whole-text match): 2
    failures — `expected true to be false` on the echoed-prompt and
    no-marker-gap cases.
- Live observation raw logs: `docs/junior-artifacts/n0-observation-run4.log`
  (round 1, probe timeline + DOM recon) and
  `docs/junior-artifacts/n0-observation-run5-gate.log` (round 2, the shipped
  gate end-to-end on a multi-line department-shaped prompt).

## Untouched (deliberately)

- `requireActivityStart` (front gap) — unchanged for juniors, **justified**: the
  flag demands an explicit `working` indicator before any completion, and juniors
  legitimately finish fast with no observable working phase (the calibration
  smokes replied in seconds with no Stop control ever seen) — wiring it would
  false-STALL those at `stallMs`. For marker-carrying prompts the front gap is
  now covered by the gate itself (a just-echoed prompt is NOT evidence — pinned
  by the round-2 unit test); sentinel-less CLI prompts keep the historical
  junior semantics.
- Fix B (worktree-dirty evidence) — follow-up hardening, needs worktree plumbing.
- Seniors — the gate is junior-only (a senior's verdict already carries its own
  fail-closed marker discipline).
- `scripts/n0_observe.ts` — kept as the observation record (throwaway harness
  script, not wired into the engine).

## Round 2 — the senior's REVISE, addressed

The senior caught a real defect in round 1's wiring (its verdict text is preserved
in the verdict doc): evidence went through `extractAgentReply`, whose needle is the
whole (multi-line) prompt — no single transcript line can ever equal or contain it,
so the function always fell back to the page's last 12 lines, which right after
send IS the echoed prompt: the marker inside the echoed instruction could open the
gate with zero agent output. (The round-1 observation dodged this only because its
prompt was single-line — the one shape the needle match handles.)

1. **Line-aware evidence (required change 1).** New pure, exported helper
   `juniorCompletionEvidence(fullText, prompt)` in `antigravity.ts` =
   `sliceAfterPrompt(fullText, prompt).includes(JUNIOR_COMPLETION_MARKER)` —
   `sliceAfterPrompt` keys off the prompt's LAST line (the technique
   `senior.ts` already uses for this class of problem). The seam now wires
   `completionEvidence: () => juniorCompletionEvidence(await
   session.readTranscript(250), prompt)`. Fallback analysis: if the prompt's
   last line has scrolled out of the read window, the echoed marker (2 lines
   above it) has too — a marker in the whole-text fallback can only be the
   agent's own (pinned by a unit test).
2. **The demanded test (required change 2).** `test/unit/tc_antigravity.test.ts`
   +4: a JUST-ECHOED realistic multi-line department prompt (chrome only, no
   agent output) is NOT evidence; the agent's marker IS; a no-marker reply
   (the exact b55e2fda "I have launched the initial vitest run" shape) is NOT;
   the scrolled-out fallback still counts the agent's marker. Plus the
   sentinel-line filter test below.
3. **`requireActivityStart` exemption justified (required change 3)** — see
   "Untouched" above.
4. **Live re-observation with a department-shaped multi-line prompt (nice-to-have
   4).** `docs/junior-artifacts/n0-observation-run5-gate.log`: the SHIPPED gate
   (`waitForAgentIdle` + `completionEvidence` via the helper) held ~80s of
   `awaiting-evidence` through the real 90s-subprocess gap and completed only at
   the agent's true final marker (t=126s) — no echo false-positive.
5. **Minor, adopted:** `extractMarkedBlock` now filters the sentinel line, so
   plan/walkthrough artifacts don't end with a stray `BUREAU-JUNIOR-COMPLETE`.
6. **Mutation M-N0c recorded** (helper checks the whole text, no slice → the
   echo and gap tests fail: `expected true to be false` ×2).

**Known residual, fail-closed:** an agent that quotes the prompt's LAST
instruction line *below* its marker could push the slice start past the marker
(evidence false → loud `stalled` at `evidenceTimeoutMs`, never a silent
false-open). Observed benignly in run5 (the agent echoed an instruction line
after the marker; it did not exactly match the prompt's last line). If it bites
in practice, harden by matching on the marker line itself as an alternative
boundary.
