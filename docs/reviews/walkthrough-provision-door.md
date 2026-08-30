# Walkthrough — Flow-resilience fix pack, Stream 4: slugify at the provisioning door + NonRetryable refusals

**Branch:** `wt/junior-b-provision-door` · **Tip:** `d2177b0` · **Base:**
`main` = `d334004` · **Plan:** `docs/plan-flow-resilience-fixpack.md`
(untracked) · **Status:** NOT merged — awaiting senior verdict.

## The defects (evidence, live DB journal #846–#857 and #806–#812)

1. The console provisioned "trading analysis": `POST /api/projects/provision`
   enqueued `project.provision:dept-trading analysis` (a space in the JOB
   ID) without validating; the slug guard fired INSIDE the job — 3 attempts,
   3 guardrail spans, dead letter. The operator's workaround then registered
   the project at `D:\projects\Trading data analysis` (space-bearing path).
2. Deterministic refusals were retried: the provision slug guard ×3, and the
   2026-08-28 zombie `pr.create` retried "task is done (must be
   needs-review)" twice AFTER the work had shipped.

## Changes

1. **`slugifyProjectName`** (exported from `provision.ts` — the one
   derivation, consistent with the engine guard's grammar). The console
   endpoint slugifies BEFORE enqueueing: payload carries the slug; canonical
   name and job id are built from it; **400 VALIDATION_ERROR** when a name
   has no slug form (no job row, no dead letter); the human span records
   BOTH raw name and derived slug.
2. **`NonRetryableError`** (in `engine/jobs/jobs.ts`) + `failJob`
   `{forceTerminal}` + runner passes it when the error is non-retryable
   (`instanceof` or `nonRetryable === true`). Wrapped:
   - `project.provision` — every `ProvisionError` (all codes are
     deterministic guardrail refusals) → dead on first failure.
   - `pr.create` — precondition refusals throw `PrRefusalError`
     (`delivery/types.ts`, extends DeliveryError, `nonRetryable = true`);
     provider/exec failures stay retryable.
3. **`projectPathWarnings`** (`engine/projects/manager.ts`): space-bearing
   repo paths are recorded in the `project-registered` span detail and
   surfaced on `ProjectDTO.warnings`. WARNED, not refused — the
   department's own repo path (`D:\Dept of code v2`) has spaces and works;
   refusal would block re-registering it.

## Claims (re-runnable)

- Suite **602/602** (run 2; run 1 had the known `t4` parallel-load flake —
  `T4b: hard process kill`, documented class, passed in the next run) ×1
  further green run; `npx tsc --noEmit` clean.
- New `tc_provision_door.test.ts` (18 tests): slugify table (incl. unicode,
  overlong, punctuation-only) + a guard-grammar consistency property;
  real-git registerProject warning present/absent; terminal-at-1 for both
  refusal classes via `drainSingleJob` (`attempts = 1`, exactly ONE
  guardrail span); door 202 (job id `project.provision:dept-trading-
  analysis`, payload slug, span raw+slug) / 400 (no job row) / 401.
- **M-PD-1 (real, executed):** door sends the raw name → 2 failures
  ("expected 'dept-trading analysis' to be 'dept-trading-analysis'";
  "expected 202 to be 400").
- **M-NR-1 (real, executed):** runner drops `{forceTerminal}` → 2 failures
  ("expected 'pending' to be 'dead'" on both terminal-at-1 tests).
  Both restored, re-verified.

## For the senior to re-run

`npx vitest run test/unit/tc_provision_door.test.ts` — then M-PD-1
(replace the `slugifyProjectName(name)` call with `name`) and M-NR-1
(strip the failJob opts object) via the recorded edits.

## Honest notes

- The engine-side slug guard is UNCHANGED and still fires (defense in
  depth); with the slugified payload it passes. Direct CLI/job enqueues of
  invalid names now die at attempt 1 instead of 3.
- The already-registered live project row ("Trading data analysis", space
  path) is an OPERATOR repair (rename folder + update row, journaled), not
  code — documented in the plan doc, not performed here.
