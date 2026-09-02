# Senior verdict — N12 bounded infra-class auto-retry for plan authoring

- **Task:** N12 (pre-Phase-8, P1) — "Bounded auto-retry for plan.cycle on infra-class attach misses only"
- **Branch:** `wt/n12-plancycle-infra-retry` at `989e400` (cut from current main `94303e1`, cleanly mergeable)
- **Senior:** claude (headless `claude -p` subprocess, adversarial close-read with
  repo tool access). **Disclosure:** the implementer is this `claude-opus-4-8`
  session; the reviewer is a **separate, fresh `claude -p` subprocess** driven with
  independently-supplied evidence — an independent review, same model family. The
  subprocess could not execute the suite in its sandbox and relied on static
  verification cross-referenced against the already-merged N15/watchdog patterns.
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-02
- **Verdict:** **APPROVE**

## What was reviewed

`plan.cycle` is `max_attempts:1`, so a cold-IDE attach miss ("workbench window did
not become available" / "no CDP window titled … appeared") during plan authoring
died terminally and needed an operator rekick — the N4/N12 cold-start scar, which
bit hard under concurrency (it stranded N9/N10/N12/N2 in the concurrent run).

Fix (`engine/flow/plan_review_cycle.ts`): the plan-authoring `runCommand` is wrapped
in a bounded retry loop scoped **strictly** to the infra class via the existing
narrow `isJuniorWedgedWindowError(err)` classifier (`engine/harness/antigravity.ts`).
Budget default `DEFAULT_PLAN_AUTHORING_INFRA_RETRIES = 2` (env
`PLAN_AUTHORING_INFRA_RETRIES` > meta `plan:authoring_infra_retries` > default, via
`readAuthoringInfraRetries`, mirroring N15's `readSeniorStallRetries`). The loop sits
**inside** the N11 `try { … } finally { heartbeat.stop(); releaseLease() }`, so the
held per-junior window lease is reused across attempts and released on success, on
agent failure, and on infra-exhaustion. A genuine AGENT failure (stall net,
login/modal wall) is not matched by the classifier and stays terminal on the first
miss — the "failed agent cycles are operator action" rule is unchanged. This is the
junior analogue of N15's senior-stall retry. Retries are journaled as
`plan_authoring_infra_retry` guardrails.

## Independent verification (by the subprocess senior)

All eight invariants checked against source and confirmed:
1. Scoping — only `isJuniorWedgedWindowError` matches retry; agent stalls propagate.
2. Boundedness — capped at `maxInfraRetries + 1` calls, then rethrows (no infinite loop).
3. Lease safety — retry inside the N11 try/finally; `releaseLease` idempotent; no leak/double-release.
4. Abort — abort-specific throw is textually distinct from the classifier; `opts.signal` passed each attempt.
5. Journaling — `guardrail` kind, distinct `action`, distinguishable from an agent verdict.
6. N11 test adaptation — switched to a genuine agent stall; still asserts terminal failure + lease release.
7. New N12 tests — non-vacuous (distinguishing `calls` counts + lease/journal side effects).
8. Blast radius — disjoint from N15's senior-stall loop; plan-rounds ceiling checked once before authoring.

## Evidence

- Full suite **706/706** across 127 files green; `tsc --noEmit` clean.
- Mutations (`docs/mutation-evidence-phase8.md`): **M-N12a** (drop the classifier →
  agent failure gets retried; 2 tests fail) and **M-N12b** (disable the retry → infra
  miss goes terminal; 1 test fails), both restored to green.
- Tests: `test/integration/tc_plan_authoring_lease.test.ts` — infra miss retried→succeeds,
  agent failure not retried (terminal, lease released), retries bounded (exhaustion terminal).

VERDICT: APPROVE
