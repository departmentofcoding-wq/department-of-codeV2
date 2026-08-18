# Junior A — Operator Console Stream A Brief: Backend API + Action Door

**To:** Junior Engineer A
**From:** Operator
**Branch:** `wt/junior-a-console` (cut from post-D0-C `main`, `11cfdaa`)
**Theme:** a secure localhost seam into the engine — read the department, act on it, never bypass a guard.

---

## 0. Before you write a line of code

1. Read `AGENTS.md`, `docs/DEPARTMENT_STATUS.md`, then `docs/console-plan.md`
   (your stream is Stream A) and the **Security posture** section in that plan —
   it governs every milestone.
2. `git log --oneline -10` and `git status`. Confirm `main` contains **D0-C**
   (`console/contract.ts` with the DTOs, `ENDPOINTS` manifest, and auth
   constants). If not, stop and tell the Operator — you cannot start until D0-C
   is merged.
3. `npx vitest run` and `npm run build` — both green before you branch (expect
   ~70s serial; 206/206, 61 files).
4. Cut `git checkout -b wt/junior-a-console` from `11cfdaa`.

**You build on the frozen D0-C contract.** Import DTOs, `ENDPOINTS`, and the auth
constants from `console/contract.ts` — do not redefine them. A new endpoint or a
changed DTO is a contract change: request an Operator mini-freeze, don't smuggle
it into a handler.

## 1. Non-negotiable security constraints (tested as guards)

- **Bind `127.0.0.1` only** (use `CONSOLE_BIND_HOST`), never `0.0.0.0`.
- **Every `/api/**` call requires the per-launch token** (`x-console-token`);
  static assets are public. Missing/wrong → `401`, journaled.
- **No secrets over the wire** — no response serializes `process.env` or keys;
  text passes through `redactOutput` (`engine/contract/tools.ts`).
- **All state changes are POST, journaled, `human-operator`-attributed.** No GET
  has side effects.
- **Triggers enqueue jobs** (`enqueueJobIfAbsent`) — never run work inline.
- **Zero new runtime dependencies** — `node:http`, `node:crypto` only.

## 2. The review loop (per milestone, in order)

1. Post a plan (files, endpoints, tests) → wait for Senior review.
2. Implement on `wt/junior-a-console`; commit on the branch, never touch main's tree.
3. Record real mutation evidence in `docs/mutation-evidence-console.md` — mutate
   the real guard, watch a real test fail, restore, paste logs. The Senior
   reproduces it.
4. Post a walkthrough with re-run `npm run build` + suite output and the exact
   commit hash. **Claims must match reality** — re-run the build every time.
5. Operator merges after a posted verdict citing your hash.

## 3. Milestones

### A1 — HTTP server skeleton + auth (`console/server.ts`)
`node:http` server: binds `127.0.0.1:<port>`; token middleware (public static +
token-gated `/api`); JSON body parse with `MAX_JSON_BODY_BYTES` cap; uniform
`ApiErrorResponse` envelope; `Cache-Control: no-store`, no `Server` banner;
static serving from `console/public/` with **path-traversal refusal**; graceful
shutdown. `GET /api/health` (token-gated) → `HealthDTO`.

**Tests (T-C1):** off-loopback bind refused; `/api/health` without token → 401
(journaled); traversal (`/../secret`) refused; oversized body → 413.
**Mutation:** widen bind to `0.0.0.0` → the loopback-only test fails.

### A2 — Read endpoints (pure, no writes)
`GET /api/dashboard` (B2 `dashboardSnapshot` → `DashboardDTO`), `/api/tasks`
(`TaskSummaryDTO[]`), `/api/findings` (active `bureau_watchdog_findings` →
`FindingDTO[]`), `/api/journal?taskId&kind&limit` (via `timeline` →
`JournalEntryDTO[]`). Shapes match the D0-C DTOs exactly; text redacted.

**Tests (T-C2):** each endpoint's shape matches its DTO; a full read pass mutates
zero rows (before/after snapshot, like T49); a planted secret never appears in
any response. **Mutation:** drop the `redactOutput` pass → the secret-leak test fails.

### A3 — Action endpoints (the write door)
**First extract a non-interactive approval core.** The only approval entry point
today is `approveTaskInteractive(db, …)` in `scripts/approve.ts` — it prompts on
the console and cannot be called from a handler. Factor out
`approveTask(db, taskId, approvedBy): ApproveTaskResult` (sets
`approved_at`/`approved_by` through the DB invariant + a journaled `human` span);
have **both** `approveTaskInteractive` and the console handler call it — no forked
logic, no raw SQL. Then:
- `POST /api/tasks/:id/approve` → routes through that core; **refuses** a task
  that is not verifier-passed (the DB `CHECK` enforces done ⇒ exit 0 + approval).
- `POST /api/actions/trigger` → enqueues `watchdog.sweep` or `backup.push` via
  `enqueueJobIfAbsent` (dedupe id), never inline. Refusals emit `guardrail` spans.

**Tests (T-C3):** approve on an unverified task refused (invariant holds); approve
on a verified task transitions it + journals a `human` span; trigger enqueues
exactly one job (idempotent); unauthenticated action → 401. **Mutation:** make
approve issue a raw `UPDATE … state='done'` bypassing the core → the
unverified-approve test catches the invariant breach.

## 4. Boundaries & coordination
- You own `console/server.ts` + the endpoint handlers + the extracted
  `approveTask` core. Junior B owns `console/public/**` and the launcher. Keep
  `package.json` edits minimal; whoever merges second rebases.
- Tests use temp DBs and **ephemeral ports** (`listen(0)`), never `db/bureau.db`,
  and clean up.

## 5. Definition of done for Stream A
A1–A3 merged with posted Senior verdicts; suite + build green on `main`;
T-C1–T-C3 green twice; mutation evidence recorded and reproducible; the ledger
updated by the Operator at each merge.
