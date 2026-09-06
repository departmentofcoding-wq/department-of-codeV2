# Senior verdict — Claude senior review efficiency (read-only tools, Opus-4.8 default, usage capture)

**Verdict: APPROVE**
**Senior:** claude (Claude Code CLI subprocess, headless)
**Model:** claude-opus-4-8
**Kind:** phase4 code-diff review (drove the dept's own `ClaudeCliSenior` on `git diff HEAD`)
**Date:** 2026-09-06
**Review latency:** ~180s
**Usage (captured live via the new `--output-format stream-json` path):**
inputTokens 24, cacheRead 495136, cacheCreation 48319, outputTokens 10617,
total_cost_usd ≈ 0.996 (API-equivalent estimate under subscription; token counts
are the reliable signal), numTurns 16, session b9216e14.

## Scope reviewed
Diff across `engine/harness/senior.ts` (+180) and the three flow cycles
(`plan_review_cycle.ts`, `work_review_cycle.ts`, `diff_review_cycle.ts`) plus
`test/unit/tc_senior.test.ts` (+152). 21 KB diff, reviewed from the inlined diff
(the read-only tool cap held — the senior did not re-run the suite).

## What the senior verified
- **CLI flags exist and are used correctly** (checked against `claude --help`):
  `--allowedTools "Read Grep Glob"` (single token, stops before `--model`);
  `--exclude-dynamic-system-prompt-sections` genuinely applies because the code
  uses `--append-system-prompt` (default system prompt stays in effect), not
  `--system-prompt`; `--fallback-model` (`-p` present); `--output-format
  stream-json` + `--verbose` in print mode; `claude-opus-4-8` is the correct id.
- **Type/wiring**: `journal` span type accepts `tokensIn/tokensOut/costUsd`;
  `ApproveParams`/`ReviseParams` gained `usage?: SeniorUsage`, both call sites pass
  `review.usage`, `SeniorUsage` imported. No type break.
- **`parseClaudeStreamJson`** robust: interleaved non-JSON tolerated, no-`result`
  fallback to stitched assistant text, empty-on-garbage so the caller falls back
  to raw stdout (where the `VERDICT:` marker still parses).
- **Acceptance coverage**: read-only cap ✓, Opus-4.8 default ✓, `--fallback-model`
  ✓, stream-json usage → journal spans (plan/work/diff) ✓,
  `--exclude-dynamic-system-prompt-sections` ✓, all four env overrides preserved
  with correct precedence ✓, zai/ZCode path untouched ✓, pure fns unit-tested ✓.

## Caveats (non-blocking)
- The senior's sandbox denied `npm`/`tsc`/`vitest`, so it verified compilation
  statically. Operator-side runs confirm it: **suite 810/810 across 132 files,
  tsc clean** apart from one pre-existing unrelated error in
  `tc_resume_flow.test.ts` (present with these changes stashed).
- Behavioral note: dropping `Bash` means the senior can no longer run tests/build
  during review — the intended quota fix; reviews now depend on the inlined
  plan/diff/walkthrough being complete.
- `total_cost_usd` under subscription auth is an API-equivalent estimate; the
  token counts are the reliable cost signal.

Independent-reviewer note: zai/ZCode was live on 9335 (v3.10.1) and was attempted
first for independence, but its selectors are calibrated for 3.9.2 and the attach
did not converge in time; the review was run on the claude senior (operator
authorized "zai or claude"), which also live-validated the exact modified path.
