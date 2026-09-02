# Plan: An official task-filing door for peer agents (Claude + GLM 5.2)

> Verbatim record of the operator-approved plan executed on `wt/agent-task-door`
> (2026-08-27). Untracked by operator convention (plan docs are the operator's
> call to commit), same as `docs/plan-project-provisioning.md`.

## Context

Today the department has exactly **one** way a `bureau_tasks` row is born:
`createSession → confirmVerify (human-operator ONLY) → fileTask` (funnelled through
`engine/filing/file_task.ts:7`). The conversational Intake Officer is just an LLM
wrapper around that path. There is **no sanctioned, non-conversational, agent-callable
door** to enqueue a task. So when the peer Claude session or the GLM 5.2 senior want to
add work, they either drive the intake chat as `human-operator` or hand-write DB rows —
i.e. "hijack the code." That directly conflicts with the department's core scar: *every
act is a tracked, attributed, journaled thing; no out-of-band writes.*

This builds an **official task-filing API** — one engine helper with an HTTP endpoint
and a CLI on top — so both agents add tasks through a real, attributed, journaled door.
It copies the proven **provisioning** template (actor allowlist + guardrail spans + zod
job + deterministic id + multiple front doors) rather than inventing a new pattern.

**Decisions locked with the operator:**
1. **Verify gate → Autonomous auto-file (opt-in).** Agent-filed tasks auto-confirm their
   verify command and kick off planning immediately, gated behind a `bureau_meta` flag
   that is **OFF by default** (fail-closed). The done-gate (verifier exit 0 + human
   approval before merge) stays absolute — this only removes the *start-side* human
   verify-confirm gate, and only when the operator has opted in.
2. **Transport → HTTP endpoint + CLI**, both thin wrappers over one engine helper.
3. **Attribution → reuse `senior-engineer`.** Claude = `senior-engineer/anthropic`,
   GLM = `senior-engineer/zai` (provider+model carry identity). No change to the frozen
   `ACTOR_ROLES` vocabulary.

## Design

**One engine helper is the real logic; endpoint + CLI just call it.** It reuses
`createSession`, the existing verify-confirm columns, and the unchanged `fileTask` —
it never re-implements task insertion.

### 1. Engine helper — `engine/filing/agent_file.ts` (new)
`fileAgentTask(db, input)` where
`input = { title, intent, spec?, acceptance?, verifyCmd, projectId?, idempotencyKey?, attribution }`.
Returns `BureauTaskRow`. Throws a typed `AgentFileError` (with `.code`, mirroring
`ProvisionError` in `engine/projects/repo_provider.ts`) and writes a `guardrail` journal
span on every refusal. In ONE `db.execTransaction`:

1. **Actor allowlist gate** — refuse unless `attribution.actor_role` ∈ a new
   `AGENT_FILE_ACTOR_ROLES = ['senior-engineer','human-operator']` const (see §5).
   Refusal → `guardrail` span + throw (code `actor_not_allowed`). Mirrors
   `provisionProject` at `engine/projects/provision.ts:22`.
2. **Autonomy-flag gate (fail-closed)** — read the opt-in flag from `bureau_meta`
   (`isAgentAutofileEnabled(db)`). If OFF, refuse with code `autofile_disabled` +
   `guardrail` span telling the operator how to enable it. This is what keeps the door
   safe-by-default.
3. **Field validation** — `title` + `intent` non-empty; `verifyCmd` present and
   **not vacuous** (reuse `isVacuousVerify` from `engine/contract/validation.ts:8`).
   Refuse → `guardrail` + throw (`missing_fields` / `vacuous_verify`). This preserves the
   one real protection the human verify gate gave: a trivial/empty verify can't slip in.
4. **Idempotency** — if `idempotencyKey` is supplied and a session already exists for it
   (`getSessionByIdempotencyKey`, `engine/intake/session.ts:67`), return that session's
   already-filed task instead of creating a second one (the deterministic-id idempotency
   pattern, applied at the session layer).
5. **Create + auto-confirm + file**, all in the same transaction:
   - `createSession(db, { title, intent, spec, acceptance, verifyCmd, projectId, idempotencyKey, attribution })`
     (`engine/intake/session.ts:15`).
   - **Auto-confirm the verify command with the AGENT'S attribution** — set
     `verify_confirmed_at`/`verify_confirmed_by` directly on the session row (via a small
     `updateSessionDraft`-style UPDATE or a dedicated `autoConfirmAgentVerify` writer in
     this module). **Do NOT touch `engine/intake/confirm.ts`** — `confirmVerify` stays
     human-operator-only, so the human door keeps its exact guarantee. Journal a `system`
     span `{ action:'agent-auto-confirm-verify', autofile:true, sessionId }` attributed to
     the agent — honest provenance: the DB records that an agent auto-confirmed under the
     opt-in flag, never a forged human.
   - `fileTask(db, sessionId, attribution)` (unchanged) → inserts the task `queued`,
     journals `task-filed` with the agent's attribution, and auto-enqueues
     `plan.cycle:<taskId>`. No changes to `fileTask`.

**Why not a new `task.file` job kind:** filing is synchronous and already atomic
(`fileTask` is one transaction that also enqueues the async `plan.cycle`). A job wrapper
would add indirection with no durability gain, unlike `project.provision` which shells out
to `gh`. Keep it a direct helper call, like intake's own `fileTask`.

### 2. Agent identity map — resolve `--agent` / `agent` → attribution
Small const `AGENT_IDENTITIES` (in the new module) so CLI and endpoint resolve the same way:
`claude → { actor_role:'senior-engineer', provider:'anthropic', model:'claude-opus-4-8', account:null }`,
`glm → { actor_role:'senior-engineer', provider:'zai', model:'glm-5.2', account:null }`.
(GLM's model id is the ZCode picker label "GLM-5.2", per `engine/harness/senior.ts`.)

### 3. CLI — `scripts/file_task.ts` (new) + `package.json` script `task:file`
`node --experimental-strip-types` + `node:util` parseArgs (matches `scripts/project.ts`).
Two input modes:
- Flags: `--title --intent --spec --acceptance --verify --project --agent claude|glm --idempotency-key`.
- `--json -` reads a JSON blob from **stdin** — this is the **GLM relay path**: GLM emits a
  structured proposal in its ZCode transcript, the operator/harness pipes it straight in.
Opens the live DB, calls `fileAgentTask`, prints the new task id (or the typed refusal).

### 4. HTTP endpoint — `POST /api/tasks/file` (Claude peer-session path)
- `console/contract.ts`: add `FileAgentTaskRequest { title, intent, spec?, acceptance?,
  verifyCmd, projectId?, agent?, idempotencyKey? }` and
  `FileAgentTaskResult { ok, task_id, state, title, created_at }`; append one entry to the
  `ENDPOINTS` manifest (30 → 31) so the contract-count test updates in lockstep.
- `console/server.ts`: register the route next to the intake routes (~`server.ts:1100`),
  token-auth + 1 MB cap + `redactOutput` like every other POST. Map `agent` →
  attribution via `AGENT_IDENTITIES` (default `claude`), call `fileAgentTask`, translate
  `AgentFileError.code` → a 400/403 `ApiErrorResponse`. The console token IS the auth; the
  `agent` field is journal identity only. The engine's flag gate still applies, so the
  endpoint is fail-closed until the operator opts in.

### 5. Constants + flag (`engine/contract/constants.ts`)
- Add `AGENT_FILE_ACTOR_ROLES = ['senior-engineer','human-operator'] as const` (a new
  allowlist array, exactly like `PROVISION_ACTOR_ROLES` at line 136 — **not** a change to
  the frozen `ACTOR_ROLES`).
- Add an `INTAKE_META_KEYS = { AGENT_AUTOFILE: 'intake:agent_autofile' }` entry; helper
  `isAgentAutofileEnabled(db)` reads it (default `false`), `setAgentAutofile(db, on)`
  sets it. No schema migration — `bureau_meta` is k/v.

### No schema changes
`bureau_intake_sessions` already carries `verify_confirmed_at/by` + `idempotency_key`;
`bureau_tasks` is untouched; the flag is a meta key. Nothing goes through `ADDED_COLUMNS`.

## Critical files
| File | Change |
|---|---|
| `engine/filing/agent_file.ts` | **new** — `fileAgentTask`, `AgentFileError`, `AGENT_IDENTITIES`, auto-confirm writer |
| `engine/filing/index.ts` | re-export the new helper |
| `engine/contract/constants.ts` | `AGENT_FILE_ACTOR_ROLES`, `INTAKE_META_KEYS.AGENT_AUTOFILE` |
| `engine/intake/session.ts` | (reused as-is: `createSession`, `getSessionByIdempotencyKey`) |
| `engine/filing/file_task.ts` | **unchanged** (reused) |
| `engine/intake/confirm.ts` | **unchanged** — human-only `confirmVerify` guarantee preserved |
| `scripts/file_task.ts` + `package.json` | **new** CLI `task:file` (flags or `--json -` stdin relay) |
| `console/contract.ts` | request/result DTOs + `ENDPOINTS` 30→31 |
| `console/server.ts` | `POST /api/tasks/file` route (agent→attribution, error mapping) |
| `test/unit/tc_agent_file_task.test.ts` | **new** — engine tests (see below) |
| `test/unit/tc_tasks_file_api.test.ts` | **new** — console endpoint tests |
| `docs/mutation-evidence-phase8.md` | M-AGENTFILE-1/2 evidence |

## Reused (do not re-implement)
- `fileTask` (`engine/filing/file_task.ts:7`) — the sole task-insert + `plan.cycle` kickoff.
- `createSession` / `getSessionByIdempotencyKey` (`engine/intake/session.ts:15,67`).
- `isVacuousVerify` / `taskGaps` (`engine/contract/validation.ts:8,21`).
- `journal` (`engine/journal/writer.ts`) — guardrail + system + task-filed spans.
- Allowlist + guardrail-span pattern from `engine/projects/provision.ts:22`.
- Test harness: `createFakeDb()` (in-memory real SQLite) + fakes, per `tc_project_provisioning.test.ts`.

## Tests (mirror T-PROV)
`tc_agent_file_task.test.ts` — **T-AGENTFILE-1..7**:
1. Happy path (flag ON): task lands `queued`, `plan.cycle:<id>` enqueued, `task-filed`
   span carries `senior-engineer/anthropic`; verify-confirm span is the agent, not human.
2. Flag OFF → refused, **zero** task rows, `guardrail` span (→ **M-AGENTFILE-1**).
3. Disallowed actor role (e.g. `junior-engineer`) → refused + guardrail (→ **M-AGENTFILE-2**).
4. Vacuous verify (`exit 0`) → refused + guardrail.
5. Missing title/intent → refused + guardrail.
6. Idempotency: same `idempotencyKey` twice → exactly one task.
7. `confirmVerify` still throws for the agent role (human-only door intact).
Plus a whole-DB secret-scan (T18 pattern) proving no key material is journaled.

`tc_tasks_file_api.test.ts` — endpoint: token required (401 without), flag-off → 403,
flag-on happy path returns `task_id`, `agent:'glm'` → `zai` attribution, missing fields → 400.

**Mutation evidence** (`docs/mutation-evidence-phase8.md`): M-AGENTFILE-1 (flip the flag
gate to always-true → test 2 fails), M-AGENTFILE-2 (widen the allowlist → test 3 fails);
exact edit → real failure output → restore → green.

## Delivery (dogfood the department's own process)
This feature touches the engine + console, so it ships through the department's own tracked
review loop, **not** a hand-merge (the paused-hand-merge scar): branch `wt/agent-task-door`,
suite green + `tsc --noEmit`, mutation evidence recorded, walkthrough → senior verdict
(`docs/reviews/verdict-agent-task-door.md`) → operator merge, ledger updated. Once live, the
very next task can be filed *through the new door itself* as the end-to-end proof.

## Verification (end-to-end)
1. `npx vitest run` (full suite) + `npm run build` (`tsc --noEmit`) — green, new tests included.
2. **Flag-off fail-closed:** `npm run task:file -- --title x --intent y --verify "npm test" --agent claude`
   → typed `autofile_disabled` refusal; confirm no new `bureau_tasks` row and a `guardrail` span.
3. **Opt in:** set `intake:agent_autofile` on (CLI/meta), re-run step 2 → prints a task id;
   `npm run dashboard` shows the task `queued` and a `plan.cycle` job pending; the `task-filed`
   journal span reads `senior-engineer/anthropic`.
4. **HTTP path (Claude peer session):** with the console running, `POST /api/tasks/file`
   with the launch token → `{ ok, task_id, ... }`; without the token → 401; flag-off → 403.
5. **GLM relay:** pipe a JSON proposal into `npm run task:file -- --json -` with `--agent glm`
   (or `"agent":"glm"` in the JSON) → task filed, journal attribution `senior-engineer/zai`.
6. Confirm `engine/intake/confirm.ts` is untouched and its human-only test still passes.
