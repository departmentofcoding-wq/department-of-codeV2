# Phase 8 Plan — Concurrency at Scale (frozen outline)

Status: **plan outline**, to be frozen for execution by a fresh window. Cut from
`main` after Part-A improvements (A1–A5) are merged. Sourced from
`docs/plan-bureau-kernel-roadmap.md` (A6) and the Phase-7 "out of scope" note.

## What Phase 8 is

The department has run tasks one at a time. Phase 8 proves it holds under
**concurrency**: many tasks × both juniors (A/B) × real window leases, with the
secretary, watchdog, queue, and budgets all correct under contention. It is
internal scale, not new capability — no new department, no kernel extraction.

Its precondition is already met: **A4 removed `fileParallelism:false`** and moved
the crash-kill/durability tests to deterministic `pollUntil` waits, so the test
harness itself can now express and survive concurrent scenarios.

## Exit sentence

> "N concurrent real tasks across both juniors run with leases, watchdog, and
> budgets holding — no stranded states, no double-claims, no flakes — and the
> journal shows every task delivered through the tracked path."

## Safety posture

- No law weakened: done-gate CHECK, merge law (+ the A1 hook), one-senior-per-task,
  budgets-as-columns all stay absolute under load.
- Real money/keys in play (live agents): spend ceilings proven-refused (A2's
  M-BUDGET-1) must hold across concurrent callers; the rolling-24h guard is a
  shared resource and must not be raced.
- Every concurrency fix ships with a deterministic test (no wall-clock races —
  the A4 discipline).

## D0-8 — Concurrency contract freeze (do FIRST)

- Freeze the invariants under contention as schema/vocab + contract-freeze tests:
  single-writer doors (`approveTask`, `rearmTask`), the atomic claim
  (`UPDATE … WHERE state=<expected> RETURNING`), the unique-active-lease partial
  index, and per-project serialization keys.
- Any new column (e.g. a per-project serialization token, or a `claimed_by`
  worker id) lands here, merged before streams — the D0 discipline.

## Stream A — Scheduler & leases under load

- Fairness: the claim query must not starve or double-claim when both juniors
  poll; prove exactly-once claim across concurrent runners (extend the T4/T28
  crash-resume family to N parallel workers).
- Window leases: acquire/heartbeat/reap correct when two dispatches target the
  same window; the unique-active-lease index is the floor.
- Per-project serialization: two tasks on the same repo must not prepare/verify
  the same worktree concurrently.

## Stream B — Watchdog, secretary & budgets under load

- Watchdog sweep + bounded recovery correct while tasks churn (no false stranded
  findings; idempotent findings under concurrent detection).
- Secretary named-key leases: fail-closed while live, holder-only release, no
  lost wakeups under contention.
- Budget guard: the rolling-24h token/request ceiling computed correctly when
  many `callModel` callers race it; refusal still proven (mutation).

## Convergence — C1: the supervised concurrent run

One recorded run of **N real tasks** (both juniors, mixed projects) from intake
to `done`, with the journal + ledger showing leases, budgets, and the tracked
delivery path holding throughout. This is the exit sentence.

## Out of scope (defer)

- Kernel extraction (Phase 9) — Phase 8 is single-department scale only.
- Dynamic task-dependency graphs / topology routing (A7 trigger, not now).

## Definition of done

D0-8 + Streams A & B merged with posted Senior verdicts; the supervised
concurrent run recorded; suite + build green under full parallelism on `main`;
ledger updated.
