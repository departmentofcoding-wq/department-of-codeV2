# Senior Verdict — Agent Task-Filing Door (`wt/agent-task-door`)

**VERDICT: APPROVE**

**Reviewed hash:** `93112cf` (implementation) + `5cd30d2` (walkthrough) on `wt/agent-task-door`, cut from `main` `d34baa0`.
**Reviewer:** claude senior (Claude CLI), acting on the operator's review request.
**Method:** full independent verification — the walkthrough's claims were re-run, not trusted.

---

## What was verified independently

### Suite (run three times — the flake-check law)
- Run 1: **501/502** — one failure, `t4_crash_resume` T4b (hard-process-kill), `pollUntil` timeout on a lease-reap span.
- Run 2: **501/502** — same single failure.
- Run 3: **502/502** clean.
- **`t4_crash_resume` in isolation: 3/3 green (T4b in 1.7s).**

That failure is the **ledger-documented parallel-load flake** (the crash-kill/browser integration
tests that contend for process/CPU slots under full `fileParallelism`), named explicitly in
`DEPARTMENT_STATUS.md`. It touches none of the machinery this change modifies (no crash/reap/lease
code in the diff) and passes in isolation and in 1 of 3 full runs. **Not a regression.**

### Build
- `npm run build` (`tsc --noEmit`): **clean.**

### Mutation evidence — both re-executed live (edit → real failure → restore → green)
- **M-AGENTFILE-1** (fail-closed flag gate): neutralized `if (!isAgentAutofileEnabled(db))` → `if (false)`.
  → `T-AGENTFILE-2` failed (`autofile_disabled` not thrown) **and** the endpoint's flag-off test failed
  (`expected 201 to be 403`). Restored → 14/14 green. The guard genuinely enforces the opt-in.
- **M-AGENTFILE-2** (actor allowlist): added `'junior-engineer'` to `AGENT_FILE_ACTOR_ROLES`.
  → `T-AGENTFILE-3` failed (`actor_not_allowed` not thrown). Restored → green. The allowlist is real.
- Working tree confirmed byte-clean after both restores (`git diff` empty).

## Design review (independent read of the full diff, +1155/−1, 12 files)

- **Ends at the unchanged `fileTask`.** `git diff main -- engine/intake/confirm.ts engine/filing/file_task.ts
  engine/intake/session.ts` is **empty**. Task insertion is not re-implemented; the door reuses
  `createSession` / `isVacuousVerify` / `journal` and copies the provisioning template
  (allowlist → guardrail spans → typed `AgentFileError`).
- **Human verify-door guarantee preserved.** `confirmVerify` stays human-operator-only; the agent
  path writes its own `verify_confirmed_*` columns via `autoConfirmAgentVerify` with the AGENT's
  attribution + an honest `system` span (`agent-auto-confirm-verify`, `autofile:true`) — never a
  forged human. `T-AGENTFILE-7` proves agents are still refused at `confirmVerify`.
- **Nested transactions are safe** under the adapter's re-entrancy guard (`engine/db/adapter.ts:61`):
  step-5's `execTransaction` → `fileFromSession` → `fileTask` all run inline under one `BEGIN IMMEDIATE`.
- **Fail-closed.** `isAgentAutofileEnabled` defaults false; the flag gate refuses **before** a session
  is created (`T-AGENTFILE-2` asserts zero sessions on refusal).
- **Refusals journal outside the filing transaction** so guardrail spans survive the throw-rollback —
  a genuine correctness point, correctly handled.
- **Endpoint authenticated.** `/api/tasks/file` is behind the global token gate
  (`console/server.ts:369`, all `/api/**`); typed refusals map to 403 (`autofile_disabled`,
  `actor_not_allowed`) / 400; title is `redactOutput`-ed.
- **Tests are substantive**, not vacuous (real assertions on state, jobs, spans, attribution,
  idempotency, whole-DB key-hygiene scan).

## Honest deviations from the plan (walkthrough §5) — all accepted
Refusals run outside the transaction (spans must survive rollback); CLI `--enable/--disable`
(required by the plan's own verification); HTTP 201 (matches `POST /api/projects`); e2e on a temp DB
(the live-DB scar outranks a literal reading). Each is reasonable and independently confirmed.

## Scope note
The done-gate (verifier exit 0 + human approval before merge) is untouched — this door only lifts the
START-side human verify-confirm gate, and only under the operator's opt-in (`intake:agent_autofile`,
default OFF). The live flag remains OFF; enabling it and filing the first real task through the door
is the operator's dogfood step.

## Merge disposition
APPROVE for `--no-ff` merge to **local main** (not pushed), consistent with the Part-A (A1–A5)
convention. Every merge is a tracked act; this verdict is posted for hash `93112cf`.
