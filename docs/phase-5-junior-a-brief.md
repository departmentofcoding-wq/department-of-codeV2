# Junior A — Phase 5 Stream A Brief: Resilience & Coordination

**To:** Junior Engineer A
**From:** Operator
**Branch:** `wt/junior-a-hardening` (cut from post-D0-5 `main`)
**Theme:** the department notices when it is stuck, and knows who owns what.

---

## 0. Before you write a line of code

1. Read `AGENTS.md`, then `docs/DEPARTMENT_STATUS.md`, then `docs/phase-5-plan.md`
   (your stream is Stream A). This brief does not replace them — it sequences them.
2. `git log --oneline -10` and `git status`. Confirm `main` already contains
   **D0-5** (the contract freeze: `bureau_ownership` + `bureau_watchdog_findings`
   tables, `recover_attempts` column, and the 5 no-op job stubs). If it does not,
   stop and tell the Operator — you cannot start until D0-5 is merged.
3. `npx vitest run` and `npm run build` — both must be green before you branch.
   The suite runs serially (`fileParallelism: false`); ~70s is expected, not a hang.
4. Cut your branch: `git checkout -b wt/junior-a-hardening` from the D0-5 merge commit.

**You are building on top of the D0-5 contract, which is frozen.** The tables,
columns, job kinds, and types already exist as verified stubs. Your job is to
give the stubs behavior — do not re-litigate the schema. If you find you need a
new column or table, that is a contract change: post it to the Operator for a
mini-freeze, do not smuggle it into a behavior PR.

## 1. The review loop (non-negotiable)

For **each** milestone below, in order:

1. Post a **plan** (components, files touched, the tests you will write) and wait
   for the Senior's review before writing code.
2. Implement on `wt/junior-a-hardening`. Commit on the branch — never leave work
   uncommitted in a checked-out tree, never touch `main`'s working tree.
3. Record **real mutation evidence** in `docs/mutation-evidence-phase5.md`: mutate
   the actual guard, watch a real test fail, restore, paste the logs. A test that
   filters its own input proves nothing — the Senior will reproduce your mutation.
4. Post a **walkthrough** with claims (exact test counts, the commit hash that
   contains the work, demo output). The Senior re-runs everything: suite twice,
   build, and your mutation. **Claims that don't match reality are this
   department's cardinal sin** — the D0-5 review already caught one mislabeled
   test. Cite the hash that actually contains the work.
5. The **Operator** merges after a posted Senior verdict citing your exact hash.

## 2. Milestones

### A1 — Watchdog: detection (`watchdog.sweep`)
A periodic, **strictly read-only** job. It scans for stranded state and writes
`bureau_watchdog_findings` rows (one journaled span per finding through the one
door). It must **never** mutate task/job state itself — detection and recovery
are separated on purpose.

Detect these four classes:
- tasks in `verifying` with no pending `verify.run` and a completed job (the exact
  crash window `WX-1` closed in code — this is belt-and-braces);
- leases past `expires_at` with no `lease.reap` enqueued;
- jobs dead-lettered with retries remaining;
- `junior.dispatch` rows with no live window lease (cross-check against Secretary
  ownership from A3 once it lands).

`watchdog.sweep` re-enqueues itself on a bounded cadence — it is a **job row, not
a `setInterval`**. Nothing fire-and-forget.

**Tests (T45):** each stranded class is found; prove read-only by asserting **zero
state mutation** (snapshot task/job tables before and after a sweep, assert equal).
**Mutation:** break one detection predicate, watch T45 miss that class.

### A2 — Watchdog: recovery (`watchdog.recover`)
A finding does **not** auto-fix. It enqueues a `watchdog.recover` job that performs
**exactly one** bounded correction and links itself back to the finding
(`recovery_job_id`), so a finding can never be silently retried into a loop.
Actions, one per finding class: re-enqueue the missing `verify.run`; fire
`lease.reap`; ring the operator for a dead-letter.

Use the `recover_attempts` budget column (frozen in D0-5). Increment it
**transactionally with the recovery action it bounds** — same statement/txn as the
state change, exactly like the other budget columns. A finding at ceiling stops,
it does not spin.

**Tests (T46):** recovery performs exactly one action and stamps `recovery_job_id`;
the `recover_attempts` ceiling halts a runaway. **Mutation:** remove the budget
increment, watch the runaway test catch the loop.

### A3 — Secretary: authoritative ownership (`secretary.claim` / `secretary.release`)
`bureau_ownership` is the **single source of truth** for who owns which
branch/window — the thing this department ran *without* while one clone churned
between juniors (five Phase 2 merge-law violations trace back to exactly this).

- `secretary.claim` is **fail-closed**: a second claim on a held, unexpired
  key is **refused**, not queued over. Expired leases (`expires_at` past) may be
  reclaimed.
- `secretary.release` requires the holder's identity (`holder_id`); a release by
  a non-holder is refused.
- Handoff notes richer than the ledger's In-flight row live in `notes`.
- Enforced discipline: a claim with no live lease is itself a Watchdog finding —
  A1 reads A3's table. This dependency is **internal to your stream**, so
  coordinate the column reads yourself; it does not block Junior B.

**Tests (T47):** double-claim on a held key is refused; wrong-holder release is
refused; expired lease is reclaimable. **Mutation:** weaken the fail-closed guard
to "last write wins," watch the double-claim test fail.

## 3. Definition of done for Stream A
All three milestones merged to `main` with posted Senior verdicts; suite + build
green on `main`; T45–T47 green run twice; mutation evidence recorded and
reproducible; the ledger updated by the Operator at each merge. Your work feeds
the Phase 5 exit sentence: *stranded work is detected and the operator is rung;
windows hand off through the record, not the chat.*

## 4. Carry-forward from the D0-5 review (applies to you)
- A test's **title must match what it actually does**. The D0-5 test labeled
  "migrates a Phase 4 database" actually used a fresh DB — don't repeat that. If
  you write a migration/recovery test, seed the real precondition state.
- Budgets increment **in the same transaction** as the state they bound. This is
  the standing invariant `recover_attempts` now joins.
- No API keys or secrets in the DB, journal, spans, or logs — env only.
