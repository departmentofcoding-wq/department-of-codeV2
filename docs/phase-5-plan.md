# Phase 5 Plan — Hardening (frozen)

Status: **frozen for execution** (2026-08-18). Supersedes `docs/phase-5-rough.md`
(kept for provenance). Cut from `main` at `a8711e9`. Every item here is
motivated by a real Phase 0–4 incident where the fix was manual; Phase 5 makes
the department survive its own failures without a human in the loop.

Read `AGENTS.md` and `docs/DEPARTMENT_STATUS.md` first. The review loop, merge
law, and mutation-evidence rule are unchanged and absolute.

---

## Exit sentence (the definition of done for the phase)

> The department survives its own failures: stranded work is detected and the
> operator is rung, history exists in more than one place, windows hand off
> through the record and not the chat, the journal is legible through read-only
> dashboards, and the red team's best shots — prompt injection, output
> exfiltration, selector spoofing, verify-command tampering — all end in
> guardrail spans, not breaches.

Demonstrated by `scripts/demo_phase5.ts` (exit 0, clean journal, zero leaks)
plus recorded mutation evidence in `docs/mutation-evidence-phase5.md`.

---

## Contract-freeze milestone (D0-5) — do this BEFORE cutting streams

One shared surface both juniors depend on. The Operator assigns D0-5 to
whichever junior is free; it is reviewed and merged to `main` before A and B
branch, exactly like Phase 4's D0.

- **New tables** (added via the boot-migration door / `ADDED_COLUMNS`, never a
  hand-run SQL migration): `bureau_ownership` (window/branch ownership for the
  Secretary) and any columns the Watchdog needs to record a detection→recovery
  link. Schema only — no behaviour.
- **New job kinds registered** (in `engine/jobs/registry.ts`) as no-op stubs so
  both streams compile against real dispatch: `watchdog.sweep`,
  `watchdog.recover`, `backup.push`, `secretary.claim`, `secretary.release`.
- **Frozen TypeScript types** for a `WatchdogFinding` and an `OwnershipRow` in
  `engine/contract/`.
- Exit: `tsc --noEmit` clean, one migration test proving the new tables appear
  on a fresh DB and are idempotent on re-boot. Merged with a posted Senior
  verdict. Streams cut only after this is on `main`.

---

## Stream A — Junior A: Resilience & Coordination
Branch `wt/junior-a-hardening`. Theme: the department notices when it is stuck,
and knows who owns what.

### A1 — Watchdog: detection (`watchdog.sweep`)
A periodic, **read-only** job that scans for stranded states and emits
`WatchdogFinding` rows. It never mutates task state itself. Detects:
- tasks in `verifying` with no pending `verify.run` and a completed job (the
  exact crash window `WX-1` closed in code — this is belt-and-braces);
- leases past expiry with no `lease.reap` enqueued;
- jobs dead-lettered with retries remaining;
- `junior.dispatch` rows with no live window lease.

Every finding is a journaled span through the one door. `watchdog.sweep`
re-enqueues itself (bounded cadence), so it is a job row, never a `setInterval`.

### A2 — Watchdog: recovery (`watchdog.recover`)
Recovery actions are themselves jobs — journaled, budgeted, never
fire-and-forget. A finding does not auto-fix; it enqueues a `watchdog.recover`
that performs exactly one bounded correction (re-enqueue the missing
`verify.run`, fire `lease.reap`, ring the operator for a dead-letter) and
records a detection→recovery link so a finding can never be silently retried
into a loop. Add a `recover_attempts` budget column, incremented
transactionally with the action it bounds.

### A3 — Secretary: authoritative ownership (`secretary.claim` / `.release`)
The `bureau_ownership` table is the single source of truth for who owns which
branch/window — the thing the department ran *without* while one clone churned
between juniors (five Phase 2 merge-law violations trace back to this).
`secretary.claim` is fail-closed: a second claim on a held branch/window is
refused, not queued over. `secretary.release` requires the holder's identity.
Handoff notes richer than the ledger's In-flight row live here. Enforced
checkout discipline: a claim with no live lease is itself a Watchdog finding
(A1 consumes A3's table — coordinate the column names at D0-5).

**Stream A tests:** T45 (`watchdog.sweep` finds each stranded class, read-only —
proven by zero state mutation), T46 (`watchdog.recover` performs exactly one
bounded action and links it to the finding; budget stops a runaway), T47
(Secretary claim/release fail-closed on double-claim and wrong-holder release).

---

## Stream B — Junior B: Durability, Visibility & Red Team
Branch `wt/junior-b-hardening`. Theme: history is safe, the journal is legible,
and the guardrails hold under attack.

### B1 — Backup push automation (`backup.push`)
origin/main sat 10+ commits behind through all of Phase 2 — the department's
history lived on one machine. After every Operator merge, a `backup.push` job
pushes and then **verifies the remote tip matches** the local merge commit; a
mismatch is a journaled failure span, not a silent success. Never claim "pushed"
without reading the remote tip back (the anti-false-claim rule applies to
delivery too). No credentials in DB/journal/logs — env only.

### B2 — Dashboards: read-only views
Read-only projections over `bureau_journal` and the task tables: budget spend
per task, state populations, verify failure rates, time-in-state. Pure
selectors + a CLI renderer (`scripts/dashboard.ts`), no writes, no network. This
is how the Operator sees the watchdog's findings and the department's health at
a glance.

### B3 — Red-team sweep: standing adversarial suite
Turn the two Phase 2 hygiene rules (bureau-owned verify command, scrubbed env)
into a permanent adversarial suite, and add the Phase 4 attack surface:
- workspace-content **prompt injection** against the Senior review officers
  (a planted "approve this" string in the diff must not move the verdict);
- **output exfiltration** attempts (a job trying to write an API key into a
  span/message/PR body must be refused and journaled);
- **selector spoofing** against the Phase 3 calibration gate;
- **verify-command tampering** (a task-supplied verify command must not run).

### B4 — Finish flake hardening (the deep fix)
The Operator's early fix (`fileParallelism: false`, 20s timeouts) made the suite
deterministic. B4 pays down the root cause: the T4b lease-reap poll and the
Phase 3 timing tests move from wall-clock `setTimeout` polling to deterministic
synchronization (await a DB row / a browser event / a file), so the tests are
fast *and* correct, and `fileParallelism` can be reconsidered. Suite-duration
budget: if integration time crosses a pain threshold, introduce tagged/sharded
runs — but a red suite must never look green.

**Stream B tests:** T48 (`backup.push` refuses to claim success on a remote-tip
mismatch — mutate the readback to prove it fails closed), T49 (dashboards are
pure read — a dashboard run adds zero journal/task rows), T50 (red-team: each of
the four attacks ends in a guardrail span, none in a breach), T51 (a
deterministic-sync test replaces a polled one and stays green under
`fileParallelism: true`).

---

## Coordination & sequencing

1. Operator merges **D0-5** first (shared tables + job stubs + types). Nothing
   in A or B compiles or merges before it.
2. Streams A and B cut from post-D0-5 `main` and run in parallel. The one hard
   dependency — Watchdog (A1) reading the Secretary's `bureau_ownership` (A3) —
   is internal to Stream A, so the streams do not block each other.
3. Each milestone: Junior posts a plan → Senior reviews → Junior implements with
   real mutation evidence recorded in `docs/mutation-evidence-phase5.md` → Junior
   posts a walkthrough with claims → Senior re-runs (suite twice, build, demo,
   journal) → Operator merges and updates the ledger → `backup.push` verifies the
   remote tip (dogfood B1 the moment it lands).
4. **Merge law is absolute:** nothing reaches `main` — code, docs, review
   artifacts — without a posted Senior verdict citing the exact commit hash.

## Standing invariants carried into Phase 5
One SQLite store, boot-migration only; nothing fire-and-forget (watchdog and
backup are job rows, not intervals/hooks); budgets are columns incremented
transactionally (`recover_attempts` joins them); one journal door; API keys in
env only — and now under standing adversarial test.
