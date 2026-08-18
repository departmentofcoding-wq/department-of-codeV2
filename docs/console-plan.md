# Operator Console Plan — Interactive Control Panel (draft)

Status: **draft for review** (not yet frozen). A net-new tooling track, not part
of any prior phase plan. Slot it as its own phase (e.g. Phase 6 — Operator
Console) or run it as a parallel tooling stream; the Operator decides the number.
Cut from `main` at the current tip after this plan is frozen.

Read `AGENTS.md` and `docs/DEPARTMENT_STATUS.md` first. The review loop, merge
law, mutation-evidence rule, and standing invariants are unchanged and absolute.
This plan splits cleanly across **two juniors** (Stream A backend, Stream B
frontend) after a shared contract freeze (D0-C).

---

## What this is

Today the department is backend + CLI only (no frontend of any kind). This track
adds a **local, single-operator web console**: a browser control panel, launched
from a **desktop shortcut**, that shows live department health (dashboards,
watchdog findings, task states, journal) and lets the operator **act** — approve
a verified task, trigger a watchdog sweep, kick a backup push — with every action
authenticated, journaled, and fail-closed.

It is the interactive superset of the read-only B2 dashboard. Because it *acts on
the department*, security and the approval door are first-class, not afterthoughts.

## Exit sentence

> An operator opens the Department Console from a desktop shortcut, sees live
> department health, watchdog findings, and task states, and can approve a
> verified task or trigger a sweep/backup — every action bound to localhost,
> authenticated by a per-launch token, journaled with human-operator
> attribution, and refused fail-closed when it would violate the done-invariant
> (verifier exit 0 AND human approval).

Demonstrated by `scripts/console.ts` launching the server + a scripted
end-to-end check (`test/integration/tCONSOLE_e2e`), plus recorded mutation
evidence.

---

## Security posture (governs every milestone — read before coding)

This is the one piece of the department that opens a network socket and performs
operator actions. Non-negotiable constraints, tested as guards:

1. **Localhost only.** Bind `127.0.0.1`, never `0.0.0.0`. A bind-address test
   asserts the server is unreachable off-loopback.
2. **Per-launch token.** The launcher mints a random token at start and prints
   the tokenized URL. Every `/api/**` call requires it (header
   `X-Console-Token` or the initial `?token=` that the page exchanges for the
   header). Static assets are public; **all data and all actions require the
   token.** Missing/wrong token → `401`, journaled.
3. **No secrets over the wire.** No response ever serializes `process.env`, API
   keys, or raw secret material; text fields pass through `redactOutput`. A test
   plants a secret and asserts it never appears in any endpoint's output.
4. **The approval door is unbypassable.** The console's "approve" routes through
   the *same* approval path as `scripts/approve.ts` and the DB invariant — it
   cannot mark a task done without verifier exit 0 AND human approval. The DB
   `CHECK` refuses; the console never issues raw SQL that would evade it.
5. **All state changes are POST, journaled, attributed to `human-operator`.**
   No GET has side effects. Refusals emit a `guardrail` span.
6. **Nothing fire-and-forget.** "Trigger sweep / backup" *enqueues a job row*
   (`watchdog.sweep`, `backup.push`) — it never performs the work inline.
7. **Zero new runtime dependencies.** Use Node built-ins (`node:http`,
   `node:crypto`) and vanilla browser JS. No web framework, no bundler — keeps
   the project's single-dep (`zod`) minimalism and needs no build step.

---

## D0-C — Console contract freeze (do this FIRST, before cutting streams)

One shared surface both juniors depend on. Assigned to whichever junior is free;
reviewed and merged to `main` before Streams A and B branch.

- **`console/contract.ts`** — frozen TypeScript DTOs and the endpoint manifest:
  - Read DTOs: `DashboardDTO` (wraps B2's `dashboardSnapshot`), `TaskSummaryDTO`,
    `FindingDTO` (from `bureau_watchdog_findings`), `JournalEntryDTO`.
  - Action DTOs: `ApproveRequest`/`ActionResult`, `TriggerRequest` (`{ kind:
    'watchdog.sweep' | 'backup.push', target? }`), and the error envelope
    `{ error: string; code: string }`.
  - `ENDPOINTS` manifest: `[{ method, path, auth: 'token' | 'public', reqType,
    resType }]` covering `GET /api/health`, `GET /api/dashboard`, `GET /api/tasks`,
    `GET /api/findings`, `GET /api/journal`, `POST /api/tasks/:id/approve`,
    `POST /api/actions/trigger`.
  - Auth constants: header name `X-Console-Token`, bind host `127.0.0.1`.
- **No new job kinds** — reuse `watchdog.sweep`, `backup.push`, and the existing
  approval path. Confirm in the walkthrough (grep, don't assume).
- Exit: `tsc --noEmit` clean; one manifest test asserting every endpoint has a
  declared auth level and DTO. Merged with a posted Senior verdict. Streams cut
  only after this is on `main`.

---

## Stream A — Junior A: Console Backend (API server + action door)
Branch `wt/junior-a-console`. Theme: a secure localhost seam into the engine.

### A1 — HTTP server skeleton + auth (`console/server.ts`)
`node:http` server: binds `127.0.0.1:<port>`; token middleware (public static +
token-gated `/api`); JSON body parse with a size cap; uniform error envelope;
security headers (`Cache-Control: no-store`, no `Server` banner); static file
serving from `console/public/` with path-traversal refusal; graceful shutdown.
`GET /api/health` (token-gated, returns `{ ok: true }`).

**Tests (T-C1):** off-loopback bind refused; `/api/health` without token → 401
(journaled); path traversal (`/../secret`) refused; oversized body → 413.
**Mutation:** widen the bind to `0.0.0.0` → the loopback-only test fails.

### A2 — Read endpoints (pure, no writes)
`GET /api/dashboard` (B2 `dashboardSnapshot`), `/api/tasks`, `/api/findings`
(active watchdog findings), `/api/journal?taskId&kind&limit` (via the existing
`timeline` query). Every response shaped to the D0-C DTOs; text fields redacted.

**Tests (T-C2):** each endpoint's shape matches its DTO; a full read pass mutates
zero rows (before/after snapshot, like T49); a planted secret never appears in
any response. **Mutation:** drop the `redactOutput` pass → the secret-leak test
fails.

### A3 — Action endpoints (the write door)
**First extract a non-interactive approval core.** Today the only approval entry
point is `approveTaskInteractive(db, …)` in `scripts/approve.ts`, which prompts
on the console and cannot be called from an HTTP handler. A3 must factor out a
non-interactive `approveTask(db, taskId, approvedBy): ApproveTaskResult` (writing
`approved_at`/`approved_by` through the DB invariant + a journaled `human` span)
that **both** `approveTaskInteractive` and the console handler call — no logic
forked, no raw SQL bypass. (D0-C review requirement, carried in.)

`POST /api/tasks/:id/approve` routes through that core (human-operator
attribution, DB invariant, journaled) — **refuses** to approve a task that is
not verifier-passed. `POST /api/actions/trigger` enqueues
`watchdog.sweep` or `backup.push` via `enqueueJobIfAbsent` (dedupe id), never
inline. Both journaled; refusals emit `guardrail` spans.

**Tests (T-C3):** approve on an unverified task is refused (invariant holds);
approve on a verified task transitions it and journals a `human` span; trigger
enqueues exactly one job (idempotent); unauthenticated action → 401.
**Mutation:** make approve issue raw `UPDATE ... state='done'` bypassing the
door → the unverified-approve test catches the invariant breach.

---

## Stream B — Junior B: Console Frontend + Desktop Launcher
Branch `wt/junior-b-console`. Theme: the operator's window and one-click launch.
Codes against the D0-C DTOs; can develop against a fixtures JSON until A2 lands.

### B1 — UI shell + testable render core
`console/public/index.html` + `styles.css` (theme-aware light/dark, responsive)
+ `app.js`. A nav shell (Dashboard / Tasks / Findings / Journal), a `fetch`
wrapper that injects `X-Console-Token`, and auto-refresh polling. **Keep all
formatting/rendering logic in a pure module `console/public/render.ts`** (DTO →
HTML string) so it is unit-testable without a browser.

**Tests (T-C4):** render functions produce the expected markup from DTO
fixtures; the token wrapper attaches the header and handles 401 by showing a
"re-launch" state. **Mutation:** break a render field mapping → the fixture test
fails.

### B2 — Views wired to the read APIs
Dashboard tiles (state populations, budget spend, verify-fail-rate, guardrail
count), task table, findings list (with subject_kind/subject_id), journal
timeline. Loading / empty / error states. Auto-refresh with a visible "last
updated" and a pause control.

**Tests (T-C5):** each view renders from a representative DTO fixture including
the empty case; error DTOs render the error state, not a blank screen.

### B3 — Action UX + desktop shortcut
Approve button with a confirm dialog; trigger-sweep / trigger-backup buttons;
success/guardrail toasts (a fail-closed refusal shows the guardrail reason, not a
fake success). Launcher `scripts/console.ts`: mints the token (`node:crypto`),
starts the server, prints and opens the tokenized `http://127.0.0.1:<port>/?token=…`.
`npm run console`. **Desktop shortcut generator** `scripts/install_console_shortcut.ps1`
(Windows, since the dept runs on win32): creates a Desktop **and** Start-Menu
`.lnk` via `WScript.Shell` that runs the launcher in the repo working dir, with
an icon; idempotent (overwrites its own shortcut, refuses to clobber unrelated
files). Document the `.desktop` / `.command` equivalents in a comment for
cross-platform, but Windows is the shipped path.

**Tests (T-C6):** launcher mints a well-formed token and URL and does not open a
browser under a `--no-open` test flag; the shortcut generator, run with
`-WhatIf`/dry-run, targets the launcher with the correct working dir and writes
nothing outside the Desktop/Start-Menu paths. **Mutation:** drop the token from
the launch URL → the URL-format test fails.

---

## Coordination & sequencing

1. Operator merges **D0-C** first (DTOs + endpoint manifest + auth constants).
   Nothing in A or B compiles or merges before it.
2. Streams A and B cut from post-D0-C `main` and run in parallel. B develops
   against a checked-in `test/fixtures/console_*.json` until A2 is available;
   the only hard contract between them is the D0-C endpoint paths + token header,
   which are frozen. No cross-stream blocker.
3. Both streams touch **`package.json` scripts** and possibly `console/` — keep
   edits localized (A owns `console/server.ts` + endpoints; B owns
   `console/public/**` + `scripts/console.ts` + the shortcut script) so the
   registry-contamination scar does not repeat. Whoever merges second rebases.
4. Each milestone: plan → Senior review → implement with real mutation evidence
   in `docs/mutation-evidence-console.md` → walkthrough with re-run build + suite
   → Operator merge after a posted verdict citing the hash.
5. **Merge law is absolute:** nothing reaches `main` without a posted Senior
   verdict for the exact commit.

## Standing invariants carried in
One journal door (every console action is a journaled span); the approval door is
unbypassable (DB invariant, not console-enforced); nothing fire-and-forget
(triggers enqueue job rows); API keys never in a response/log/journal (env only,
`redactOutput` on text); tests use temp DBs and **ephemeral ports**, never the
live `db/bureau.db`, and clean up; zero new runtime dependencies.

## Definition of done
D0-C + both streams merged with posted Senior verdicts; suite + build green on
`main`; the exit-sentence e2e passes and `npm run console` opens a working panel
from the desktop shortcut; mutation evidence recorded and reproducible; the
ledger updated by the Operator at each merge.
