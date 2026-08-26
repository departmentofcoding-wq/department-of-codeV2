# Walkthrough — A3: staged verifier implementation

**Branch:** `wt/a3-staged-verify-impl` (rebased onto current `main` = A1+A2+D0)
**Stream:** Part A / A3 (implementation) of `docs/plan-bureau-kernel-roadmap.md`

> **Base note:** this branch was rebased onto current `main` (which already
> contains A1 and A2 and the A3 D0 freeze), so its diff is clean — no phantom
> deletions of A1/A2 files. Numbers below are measured on the rebased tip.

## What this stream does

Turns the single `verify.run` command into a staged pipeline, built on the D0
freeze. The kernel contract is unchanged: verify stays deterministic and
bureau-owned, and the aggregate exit code is 0 iff every non-skipped stage
exited 0 — exactly what `handleVerifyOutcome` already consumes.

### The staged runner (`engine/verify/verifier.ts`)
- `runCommand` — the single-command execution primitive (scrubbed env, timeout,
  tree-kill), extracted from the old `runVerifier`.
- `runVerifier` — unchanged behavior for direct callers (T22/T23/T50), now a thin
  wrapper over `runCommand`.
- `runStagedVerifier` — runs the frozen `VERIFY_STAGES` in order, using the
  commands actually configured:
  - **structural** → `bureau_meta 'verify:structural_cmd'` (optional; e.g.
    `npm run build`). Kept a meta key, never hardcoded, so the kernel never
    assumes a toolchain.
  - **fail-to-pass** → `task.acceptance_tests` (optional; the tests that prove
    acceptance).
  - **pass-to-pass** → `task.verify_cmd` (required; the full suite).
  Stages with no command are recorded `skipped` (exit 0, never failing). The run
  short-circuits on the first failing stage. The pass-to-pass stage records
  `pass_after` (this run) and `pass_before` (the prior run's `pass_after`), so
  the ledger can show regressions. `parsePassCount` reads vitest-style
  "`<n> passed`" (null when unparseable — absence is not zero).
- `engine/verify/job.ts` calls `runStagedVerifier` and persists `stages` (JSON),
  `pass_before`, `pass_after`; the verify span carries a per-stage summary.

### Config (`engine/contract/constants.ts`)
- `BUDGET_META_KEYS.VERIFY_STRUCTURAL_CMD = 'verify:structural_cmd'`.

## Claims (for independent senior verification)

1. **Suite green:** `473 / 99` pass on the rebased tip; `npm run build` clean.
   (D0 base on current main was 465/99 → +8, the T47 file.)
2. **Back-compat:** the 8 existing verify test files
   (t9/t22/t23/t24/t27/t28/t29/t50) stay green — with nothing else configured the
   pipeline degrades to running just `verify_cmd`, so exit code, tails,
   redaction, timeout-kill, and transitions are unchanged.
3. **M-STAGE-1 (mutation):** forcing `stageOk = true` fails the two short-circuit
   cases in `t47` (a failing stage no longer fails the run; later stages still
   run); restored → 8/8.
4. **T47 covers:** all-three-pass (ordered stages, pass count parsed), graceful
   degradation (skipped entries), structural short-circuit, fail-to-pass
   short-circuit, vacuous-stage refusal, `pass_before/after` across runs, and job
   persistence + `needs-review` transition.

## Deferred (honest scope note)

Intake drafting of `acceptance_tests` (the officer proposing the targeted tests)
is **not** in this stream: it needs an `bureau_intake_sessions.acceptance_tests`
column, which belongs in a D0 schema addendum, not an implementation stream. The
verifier already consumes `task.acceptance_tests` when present (proven by T47);
until intake populates it, the fail-to-pass stage is simply skipped. Follow-up:
a small D0 addendum (session column) + officer `propose_field` enum extension +
`fileTask` mapping, under the existing human confirm-verify gate.
