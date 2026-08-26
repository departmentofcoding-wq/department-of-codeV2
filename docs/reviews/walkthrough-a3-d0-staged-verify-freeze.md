# Walkthrough — A3 D0: Staged Verification Contract Freeze

**Branch:** `wt/a3-d0-staged-verify-freeze` (cut from `main` = `562d2a9`)
**Stream:** Part A / A3 (D0 freeze) of `docs/plan-bureau-kernel-roadmap.md`
**Milestone type:** D0 contract-freeze — schema + vocab only, **no behavior**,
merged BEFORE the stage-runner implementation stream branches (department phase
discipline).

## What this freezes

The surface the staged-verify implementation will build on. The kernel contract
is deliberately unchanged: verify stays a deterministic, bureau-owned command
whose exit code is 0 iff every non-skipped stage passed. Only the *command*
becomes a staged pipeline, later, inside the existing `verify.run` job.

### Vocabulary (`engine/contract/constants.ts`)
- `VERIFY_STAGES` — frozen, ordered: `['structural', 'fail-to-pass', 'pass-to-pass']`
  (stage 3, mutation spot-check, deliberately deferred). `VerifyStage` type.

### Types (`engine/contract/types.ts`)
- `VerifyStageResult` — `{ stage, exit_code, duration_ms, skipped?, detail? }`,
  serialized into the run row's `stages`.
- `BureauVerifyRunRow` gains `stages`, `pass_before`, `pass_after` (all nullable).
- `BureauTaskRow` gains `acceptance_tests` (the tests that prove acceptance —
  the input to the `fail-to-pass` stage).

### Schema (`engine/db/schema.ts`)
- New **nullable** columns on `bureau_verify_runs` (`stages`, `pass_before`,
  `pass_after`) and `bureau_tasks` (`acceptance_tests`), added to the base
  CREATE TABLEs, the `bureau_tasks` rebuild path, and `ADDED_COLUMNS` (so every
  existing DB, including the live one, gains them on next boot). Legacy rows read
  null; no CHECK touched; the done-gate is unchanged.

### Freeze test (`test/unit/contract_d0_verify_stages.test.ts`, 6 tests)
Vocabulary members + order, `VerifyStageResult` shape, column presence on both
tables, additive/nullable inserts round-tripping the staged payload, and boot-door
idempotency on reopen.

## Claims (for independent senior verification)

1. **Behavior-preserving:** full suite `441 / 95` passes (baseline 435/94 → +6,
   the freeze test only), `npm run build` (`tsc --noEmit`) clean. No existing test
   changed.
2. **Additive/nullable:** a legacy-shaped `bureau_verify_runs` insert (no
   `stages`/`pass_*`) succeeds and reads null; the staged payload round-trips.
3. **Migration-safe:** columns present on a fresh boot AND after a close/reopen
   (ADDED_COLUMNS skips existing columns via `table_info` — no duplicate-column
   error).

## Next stream (builds on this freeze, does NOT ship here)

The stage-runner implementation (`engine/verify/verifier.ts` + `loop.ts`):
- Run stages in order inside `verify.run`, each a bounded command with its own
  timeout; overall exit 0 iff every non-skipped stage exits 0.
- Stage 0 structural (`tsc --noEmit` + lint on changed files); stage 1
  fail-to-pass (tests from `task.acceptance_tests`, skipped when none named);
  stage 2 pass-to-pass (full suite; record `pass_before`/`pass_after`).
- Persist `stages` JSON + pass counts on the run row; failure at any stage enters
  the existing bounded fix loop (`verify_fixes` ceiling → `blocked`).
- Intake drafts `acceptance_tests` (`engine/officers/task_intake_officer.ts`,
  `engine/contract/tools.ts`) under the existing human confirm-verify gate.
- Mutation evidence per new guard; `t47_staged_verify.test.ts`.
