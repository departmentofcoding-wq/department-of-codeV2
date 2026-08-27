# Walkthrough — Agent task-filing door (`wt/agent-task-door`)

Implementation tip: **`93112cf`** (this doc rides on top of it on the same branch).
Plan: `docs/plan-agent-task-door.md` (verbatim, untracked by operator convention).
Every claim below was produced by a real run in this session and can be re-run by
the reviewer. The plan's three locked decisions are implemented as decided:
opt-in auto-file (fail-closed), HTTP + CLI over one engine helper, attribution
reusing `senior-engineer` with provider+model carrying identity.

## What shipped

| File | Change |
|---|---|
| `engine/filing/agent_file.ts` | **new** — `fileAgentTask` (gates + create/auto-confirm/file), `AgentFileError`, `AGENT_IDENTITIES` (claude/glm), `isAgentAutofileEnabled`/`setAgentAutofile`, `autoConfirmAgentVerify` |
| `engine/filing/index.ts` | re-exports the new module |
| `engine/contract/constants.ts` | `AGENT_FILE_ACTOR_ROLES = ['senior-engineer','human-operator']` (new array; frozen `ACTOR_ROLES` untouched), `INTAKE_META_KEYS.AGENT_AUTOFILE = 'intake:agent_autofile'` |
| `scripts/file_task.ts` + `package.json` | CLI `npm run task:file` — flags mode, `--json -` stdin relay, `--enable`/`--disable` operator toggle |
| `console/contract.ts` | `FileAgentTaskRequest`/`FileAgentTaskResult` DTOs; `ENDPOINTS` 30 → 31 |
| `console/server.ts` | `POST /api/tasks/file` next to the intake routes (token-auth, 1 MB cap, `redactOutput`, error-code mapping) |
| `test/unit/tc_agent_file_task.test.ts` | T-AGENTFILE-1..8 |
| `test/unit/tc_tasks_file_api.test.ts` | endpoint tests (auth, 403, 201, glm identity, validation, manifest) |
| `test/unit/contract_d0_c.test.ts` | ENDPOINTS lock 30 → 31, new path asserted |
| `docs/mutation-evidence-phase8.md` | M-AGENTFILE-1/2 (new file) |

**Untouched, verified:** `engine/filing/file_task.ts` (reused as the sole insert +
`plan.cycle` kickoff), `engine/intake/session.ts` (reused), and — the load-bearing
guarantee — `engine/intake/confirm.ts` (`git diff main -- engine/intake/confirm.ts`
prints nothing; `git status engine/intake/` clean). No schema changes; the flag is a
`bureau_meta` key.

## Claims (all re-runnable)

1. **Suite:** `npx vitest run` → **502/502 across 104 files**, run **twice**
   (10:26:56 and 10:30:42 on 2026-08-27), both green. Baseline before the branch:
   488/488 across 102; delta = +14 new tests (8 engine + 6 endpoint), contract
   lock test updated in place.
2. **Build:** `npm run build` (`tsc --noEmit`) clean on the branch.
3. **Mutations** (executed live, restored, re-verified green — logs in
   `docs/mutation-evidence-phase8.md`):
   - M-AGENTFILE-1 — flag gate `if (!isAgentAutofileEnabled(db))` → `if (false)`:
     T-AGENTFILE-2 fails (`expected undefined to be an instance of AgentFileError`)
     and endpoint test 2 fails (`expected 201 to be 403`).
   - M-AGENTFILE-2 — `'junior-engineer'` prepended to `AGENT_FILE_ACTOR_ROLES`:
     T-AGENTFILE-3 fails (`expected undefined to be an instance of AgentFileError`).
4. **End-to-end** (real CLI subprocesses + real HTTP server against a **temp DB**
   via `BUREAU_DB_PATH`, per the live-DB scar; scratch scripts + DB deleted after):
   - Flag-off refusal: `npm run task:file -- --title … --verify "npm test" --agent claude`
     → `[task:file] REFUSED (autofile_disabled): …`, exit 1, **0 tasks / 0 sessions**,
     one `guardrail` span with `code:'autofile_disabled'`, flag `<unset>`.
   - Opt in (`--enable`) → flag `true`; re-run files: task `queued`, session `filed`
     with `verify_confirmed_by:'senior-engineer'`, `plan.cycle:<id>` job `pending`,
     `task-filed` span `senior-engineer/anthropic/claude-opus-4-8`.
   - HTTP door: no token → **401 UNAUTHORIZED**; flag off → **403** `autofile_disabled`;
     flag on → **201** `{ok:true, task_id, state:'queued', …}`; `agent:'glm'` →
     auto-confirm span provider `zai`. (Two auto-confirm spans `anthropic`, one `zai`.)
   - GLM stdin relay: `echo '{…,"agent":"glm"}' | npm run task:file -- --json -`
     → `Filed by: senior-engineer/zai (glm-5.2)`, task `queued`, `plan.cycle` pending.
   - Idempotent retry: same JSON piped twice → **same task id**, still exactly
     4 tasks / 4 sessions after the whole run.
5. **Key hygiene:** whole-DB secret scan over `bureau_tasks`,
   `bureau_intake_sessions`, `bureau_intake_messages`, `bureau_journal`,
   `bureau_meta`, `bureau_jobs` (T-AGENTFILE-8, T18/T-PROV-9 pattern).

## Honest deviations from the plan text

- **Refusal gates run outside the filing transaction.** The plan says "In ONE
  `db.execTransaction`" for all five steps, but `execTransaction` rolls back on
  throw — a guardrail span journaled inside would be erased by the very refusal
  that wrote it. Steps 1–4 (gates + guardrail spans) run first; step 5
  (create + auto-confirm + file) is ONE transaction, exactly as the plan's §5
  states. This is the only way both plan requirements ("guardrail span on every
  refusal" + "create + auto-confirm + file in the same transaction") can hold.
- **CLI `--enable`/`--disable`.** Not in §3, but required by the plan's own
  verification step 3 ("set `intake:agent_autofile` on (CLI/meta)") — without it
  the only way to opt in is a hand-written DB row, the exact out-of-band write
  this feature exists to kill. The toggle journals a `human` span
  (`agent-autofile-enabled`/`-disabled`).
- **Idempotent retry of an open (unfiled) session converges** by filing that
  session — the first request's draft wins — instead of erroring; an abandoned
  session refuses with `session_abandoned`. The plan only specified the
  already-filed case; converging is the deterministic-id pattern it cites.
- **HTTP success is 201** (consistent with `POST /api/projects`); typed refusals
  carry the engine's exact `AgentFileError.code` (`autofile_disabled`,
  `actor_not_allowed` → 403; the rest → 400).
- **E2E ran against a temp DB, not `db/bureau.db`** — the status ledger's
  live-DB scar ("tests and demos use temp paths; the live DB is bureau
  property") outranks a literal reading of the verification section. The
  post-merge live filing ("the very next task through the door") is the
  operator's dogfood step, unchanged from the plan.

## Delivery state

Branch `wt/agent-task-door`, tip `93112cf` (+ this walkthrough). Awaiting senior
review (`docs/reviews/verdict-agent-task-door.md`) and operator merge — **no
hand-merge**; hand-merges remain paused per the department law. The done-gate
(verifier exit 0 + human approval) is untouched by this change; the autofile
opt-in only lifts the start-side verify-confirm for agent-filed tasks, and the
live flag is still OFF (the e2e opt-in lived and died on the temp DB).
