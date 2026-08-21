# Senior Verdict — Console Conversational Intake

**Commit under review:** `11b4ad9c77b566e4ac2d9f59857e1767e38ccef2`
**Branch:** `wt/junior-console-intake` (cut from `main` at `c85b34e`, single commit)
**Scope:** Conversational task-intake front door for the Operator Console — the
reviewed plan ("conversational intake in the console") with all six Senior
amendments folded in.
**Date:** 2026-08-21
**Verdict:** ✅ **APPROVE — merge to main**

## What was verified (independently, not trusted)

- **Suite + build, re-run by the senior:** two full runs (flake check, both
  exit 0) plus a count-verified run — **288/288 across 74 files** (main was
  281/73; +7 tests in `test/unit/tc4_intake_api.test.ts`, +1 file) — and
  `tsc --noEmit` clean. Matches the walkthrough claim exactly.
- **Plan fidelity + all six amendments present in the diff:**
  1. `runIntakeTurn` enqueues, drains inline, **re-reads the job row**, and
     maps non-`done` to 502 + guardrail span (verified: `drainSingleJob`
     swallows handler failures at `runner/main.ts:271` — the re-read is
     load-bearing).
  2. The enqueue-only `/api/actions/trigger` pattern was correctly NOT copied
     for intake (the console process runs no job loop).
  3. Frontend disables input while a turn is in flight ("Thinking…").
  4. `can_file` / `awaiting_verify_confirmation` are recomputed from the live
     session on every GET — a re-proposed verify command (which nulls
     `verify_confirmed_*` in `updateSessionDraft`) correctly re-requires
     approval.
  5. `contract_d0_c` updated 8 → 12 endpoints, all `auth: 'token'`.
  6. `redactOutput` on every intake text surface; reply to a non-open session
     → 409; `setOfficerClientOverride` used from the officer module (not
     `test/helpers/`).
- **No intake logic duplicated:** all four endpoints wrap the real engine
  helpers (`createSession`, `appendIntakeMessage`, `confirmVerify`,
  `fileTask`, `getSessionWithMessages`); officer turns run through the real
  `intake.turn` registry handler — the same code path as the CLI.
- **The human gate holds at the contract layer, not just the endpoint.**
  `taskGaps` includes `verify_confirmed`; `fileTask` refuses on any gap; the
  officer's own `file_task` tool goes through the same door. The operator
  never authors a verify command: `propose_verify` is the only writer,
  refused at three layers if vacuous (officer tool boundary, `confirmVerify`,
  `taskGaps`).
- **Tests are real:** in-process HTTP round-trips against the actual server,
  temp DB via `createFakeDb`, `MockClient` officer override (no network, no
  live DB), and DB-level assertions (`bureau_tasks` row, `task-filed` span,
  guardrail spans) — not response-shape-only checks.
- **Mutation evidence independently reproduced:** M-INTAKE-1 — removed
  `confirmVerify` from the confirm-file handler → exactly the human-gate test
  fails (`drafts the verify command via the officer, then files on human
  confirm`, expected 400 to be 200; 1 failed / 6 passed), and the failure is
  `fileTask`'s own refusal on the `verify_confirmed` gap — the guard survives
  endpoint-level tampering. Restored; 7/7 green again; tree clean. M-INTAKE-2
  (502 failure surfacing) mapped directly to the `runIntakeTurn` re-read and
  the failing-turn test assertions.

## Non-blocking notes (operator follow-ups, not merge blockers)

- `POST /api/intake` passes no idempotency key (`createSession` supports
  one); a retried create opens a second session. Acceptable for a
  single-operator loopback console.
- `intake.turn` has a 60s job timeout and one turn may chain several model
  calls; on a slow/down local provider the operator will see the (handled)
  502 path. The ledger already records live LLM-officer fragility — first
  live use is an operator activity, tests correctly use fakes only.
- The officer's mid-turn `file_task` attempts error harmlessly until the
  human confirms (by design; surfaced only in internal tool messages).

The plan's premise — task creation in the console through the officer and the
confirm-verify gate, never around them — is implemented as approved. Approved
for merge.
