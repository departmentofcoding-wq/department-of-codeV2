# Junior B — Phase 5 Stream B Brief: Durability, Visibility & Red Team

**To:** Junior Engineer B
**From:** Operator
**Branch:** `wt/junior-b-hardening` (cut from post-D0-5 `main`)
**Theme:** history is safe, the journal is legible, and the guardrails hold under attack.

---

## 0. Before you write a line of code

1. Read `AGENTS.md`, then `docs/DEPARTMENT_STATUS.md`, then `docs/phase-5-plan.md`
   (your stream is Stream B). This brief sequences them; it does not replace them.
2. `git log --oneline -10` and `git status`. Confirm `main` already contains
   **D0-5** (contract freeze: `bureau_ownership` + `bureau_watchdog_findings`
   tables, `recover_attempts` column, the 5 no-op job stubs including
   `backup.push`). If it does not, stop and tell the Operator — you cannot start
   until D0-5 is merged.
3. `npx vitest run` and `npm run build` — both must be green before you branch.
   The suite runs serially (`fileParallelism: false`); ~70s is expected, not a hang.
4. Cut your branch: `git checkout -b wt/junior-b-hardening` from the D0-5 merge commit.

**You are building on the frozen D0-5 contract.** The `backup.push` stub and job
kinds already exist and are verified. Give them behavior; do not change the
schema. A genuinely new column/table is a contract change — post it to the
Operator for a mini-freeze, never smuggle it into a behavior PR.

## 1. The review loop (non-negotiable)

For **each** milestone below, in order:

1. Post a **plan** (components, files touched, tests) and wait for the Senior's
   review before writing code.
2. Implement on `wt/junior-b-hardening`. Commit on the branch — never leave work
   uncommitted in a checked-out tree, never touch `main`'s working tree.
3. Record **real mutation evidence** in `docs/mutation-evidence-phase5.md`: mutate
   the real guard, watch a real test fail, restore, paste the logs. The Senior
   reproduces your mutation — a self-filtering "mutation" proves nothing.
4. Post a **walkthrough** with claims (exact test counts, the commit hash that
   contains the work, demo output). The Senior re-runs everything: suite twice,
   build, your mutation. **Claims that don't match reality are this department's
   cardinal sin.** Cite the hash that actually contains the work.
5. The **Operator** merges after a posted Senior verdict citing your exact hash.

## 2. Milestones

### B1 — Backup push automation (`backup.push`)
origin/main sat 10+ commits behind through all of Phase 2 — the department's
history lived on one machine. After every Operator merge, a `backup.push` job
pushes and then **reads the remote tip back and verifies it matches** the local
merge commit. A mismatch is a **journaled failure span, not a silent success** —
never claim "pushed" without confirming the remote tip. Credentials come from the
environment only; nothing secret touches the DB, journal, spans, or logs.

**Tests (T48):** `backup.push` **refuses to claim success on a remote-tip
mismatch** — mutate the readback to return a wrong hash and assert it fails
closed. **Mutation:** make the readback trust the local hash instead of the
remote, watch T48 catch the false success. (This is the anti-false-claim rule
applied to delivery itself.)

### B2 — Dashboards: read-only views
Read-only projections over `bureau_journal` and the task tables — **pure
selectors + a CLI renderer** (`scripts/dashboard.ts`). No writes, no network.
Surface: budget spend per task, state populations, verify failure rates,
time-in-state. This is how the Operator sees Stream A's watchdog findings and the
department's health at a glance.

**Tests (T49):** a dashboard run adds **zero** journal/task rows (snapshot row
counts before/after, assert equal). **Mutation:** introduce an incidental write
in the renderer, watch T49 catch it.

### B3 — Red-team sweep: standing adversarial suite
Turn the two Phase 2 hygiene rules (bureau-owned verify command, scrubbed env)
into a **permanent** adversarial suite, and add the Phase 4 attack surface:
- **workspace-content prompt injection** against the Senior review officers — a
  planted "approve this" / "ignore previous instructions" string in the diff must
  **not** move the verdict;
- **output exfiltration** — a job trying to write an API key into a span, message,
  or PR body must be refused and journaled;
- **selector spoofing** against the Phase 3 calibration gate;
- **verify-command tampering** — a task-supplied verify command must **not** run;
  only the bureau-owned command does.

Each attack must **end in a guardrail span, not a breach.**

**Tests (T50):** each of the four attacks ends in a guardrail span; none breaches.
**Mutation:** disable one guard (e.g. stop scrubbing env), watch the matching
red-team test go from guardrail-span to breach.

### B4 — Finish flake hardening (the deep fix)
The Operator's early fix (`fileParallelism: false` + 20s timeouts in
`vitest.config.ts`) made the suite deterministic but slow. B4 pays down the root
cause: the T4b lease-reap poll and the Phase 3 timing tests move from wall-clock
`setTimeout` polling to **deterministic synchronization** — await a DB row, a
browser event, or a file, not the clock. Once the timing tests are deterministic,
re-evaluate whether `fileParallelism` can return to `true`. Suite-duration budget:
if integration time crosses a pain threshold, introduce tagged/sharded runs — but
**a red suite must never look green.**

**Tests (T51):** a deterministic-sync test replaces a polled one and stays green
with `fileParallelism: true`. **Mutation:** reintroduce a race the old poll masked,
watch the deterministic test catch it reliably (not flakily).

## 3. Definition of done for Stream B
All milestones merged to `main` with posted Senior verdicts; suite + build green
on `main`; T48–T51 green run twice; mutation evidence recorded and reproducible;
the ledger updated by the Operator at each merge. **Dogfood B1 the moment it
lands** — the next merge after B1 merges should be verified by `backup.push`. Your
work feeds the Phase 5 exit sentence: *history exists in more than one place, the
journal is legible, and the red team's best shots end in guardrail spans.*

## 4. Carry-forward from the D0-5 review (applies to you)
- A test's **title must match what it actually does** — the D0-5 review caught a
  test labeled "migrates a Phase 4 database" that used a fresh DB. Seed the real
  precondition your test claims to exercise.
- The anti-false-claim rule is not just for walkthroughs — B1 bakes it into the
  code: never report success you haven't read back from the source of truth.
- No API keys or secrets in the DB, journal, spans, or logs — env only. B3 makes
  this a standing adversarial test.
