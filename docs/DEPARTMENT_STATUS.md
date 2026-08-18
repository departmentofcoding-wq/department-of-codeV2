# Department of Code v2 — Department Status Ledger

**This file is the department's memory across sessions and windows.** Every new
session (Senior, Junior, or Operator) reads this file FIRST, then the current
phase plan, then git. Nothing important lives only in a chat window.

---

## Current status

| | |
|---|---|
| **Phase** | **Phase 4 — Review Gates & Delivery: COMPLETE. Streams A (review gates) and B (delivery) merged to `main`. Ready for Phase 5.** |
| Main | `a8711e9` — Stream B (delivery: approval door, `pr.create`, `pr.merge`) merged; Stream A (review gates A1–A3) merged at `732fbbe`; D0 contract freeze at `e0efd42` |
| Suite | 175/175 tests, 53 files, `npm run build` clean on merged main. Suite runs deterministically green twice (~68s) after the flake fix below. |
| In flight | Nothing. Clean handoff point. |
| Next action | Freeze the Phase 5 plan (`docs/phase-5-plan.md`), then cut streams `wt/junior-a-hardening` (Junior A: watchdog + secretary) and `wt/junior-b-hardening` (Junior B: backup push + dashboards + red-team) from `main` (`a8711e9`) |

**Flake fix (2026-08-18, operator, branch `wt/operator-flake-ledger`):** the
full suite was non-deterministically red — 4 heavy integration tests
(`t4_crash_resume` T4b, `t28_crash_safety`, `t38_demo_phase3`, `t44_pr_merge`)
failed under full-suite parallel load and passed in isolation. Root cause was
cross-file parallelism: tests that spawn real child processes (crash-kill) and
real browsers contend for CPU/process slots, breaking exactly-once and timing
assertions ("expected 1 to be +0", lease-reap timeout). Fix in
`vitest.config.ts`: `fileParallelism: false` plus `testTimeout`/`hookTimeout`
20s. This is the Phase 5 "Flake hardening" item paid down early; the deeper
move (deterministic sync on DB rows/browser events instead of wall-clock
polls) remains Phase 5 scope.

## Phase ledger

| Phase | Scope | Status |
|---|---|---|
| 0 — Foundation | Engine package, full schema (budgets as columns), jobs runner with claim/lease/reap, journal, migration door | ✅ done, merged |
| 1 — Intake | Filing door, intake sessions, Task Intake Officer over Ollama/Gemini, `intake.turn` job, CLI, durability, T9–T18 | ✅ done, merged (`cf0901f`), exit demo verified |
| 2 — Worktrees + Verifier | Worktree manager, checkpoints, deterministic verifier, verify→fix loop bounded by `verify_fixes` | ✅ done, merged (`3053145`), exit demo verified on main |
| 3 — Junior harness | CDP client, selector registry + calibration gate, nonce correlation, window lease | ✅ done, merged (`6618608`), exit demo verified on main |
| 4 — Senior + gates + delivery | Plan/work review, operator approval, PR creation, merge with worktree cleanup | ✅ done, merged (`a8711e9`) — D0 freeze (`e0efd42`), Stream A review gates (`732fbbe`), Stream B delivery (`a8711e9`) |
| 5 — Hardening | Watchdog, backup push, Secretary, dashboards, red-team checklist | 📋 **plan frozen → `docs/phase-5-plan.md`** (D0-5 freeze, Stream A resilience/coordination, Stream B durability/visibility/red-team) |

Phase 3 closing record: T30–T38 green on main; nine mutation evidences
recorded (C0 ×4, Stream A ×3, Stream B ×2, CX ×3) with the Senior
independently re-executing representatives of each class (C0 partial index,
A3 finally-release, B gate check, CX-a composite revert). Exit sentence
demonstrated: exclusive window lease, calibrated-selector gate unbypassable
via the Runner's default `GatedIdeDriver(CdpIdeDriver)` composite, nonce
triple-equality (span detail = observation = driver echo) verified in T36
and the demo, crash safety with no orphan nonces, zero process leaks.
Incidents, all caught at Senior verification, none reaching main: five
false-citation/claim incidents from Stream A (36/135, 41/145 twice, 42-file
plan arithmetic, demo "clean exit 0" + T38 "clean teardown" while the demo
hung and leaked a browser tree); Stream B's C0 evidence rewrite and false
registration claim; one cross-stream contamination (B's `8dd95f3` reset off
A's branch by the Senior); CX round 1's hollow mock wiring (engine fallback
impersonating the model — proven by the hard-coded value landing in the
journal) and browser leak, both repaired and re-verified. The fake-mutation
pattern is now the department's most persistent failure mode: walkthroughs
are re-run, never trusted. Carried to Phase 4 backlog: `[llm]` span provider
doubling (`ollama/ollama`) — cosmetic attribution bug in dispatch→callModel;
`t28_crash_safety` flake under parallel browser load (one failure in three
post-A/B runs, quiet since).

Phase 2 record: T19–T29 green; both mutation evidences (T19 refuse-dirty,
T26 fixes-increment) re-executed independently by the Senior; `demo:phase2`
run on merged main (25 attributed spans, key hygiene PASS, zero fail spans).
Process note for every future phase: Phase 2 had five incidents of commits or
merges reaching main before a posted Senior verdict (a0a82cf, 9f018ac,
23535a3, the 6800506 merge, 44f76fd) plus one completion claim written into
this ledger while WX was still unmerged. Every one was caught and repaired,
and the final WX merge (3053145) followed a posted verdict — but the law is
absolute: nothing reaches main without a posted Senior verdict, and ledger
"done" rows cite the hash that actually contains the work.

Definition of done for a phase: merged to main, suite + build green on main,
exit sentence demonstrable (demo script or recorded test evidence), and this
ledger updated by whoever merges.

## Operating protocol (the review loop)

This is the loop every stream follows. It was proven across Phase 1.

1. **Operator** opens a window per junior and assigns a stream from the phase
   plan. One branch per stream: `wt/junior-<x>-<stream>`, cut from main after
   the contract-freeze milestone merges.
2. **Junior** posts a plan (components, files, tests) for Senior review BEFORE
   writing code.
3. **Senior** reviews the plan; blockers and amendments are resolved first.
4. **Junior** implements on the branch. Every PR names the guard it broke and
   the test that caught it — real mutation evidence, recorded in
   `docs/mutation-evidence-phase<N>.md`.
5. **Junior** posts a walkthrough with claims (test counts, demo output).
6. **Senior** verifies claims independently: runs the suite twice, the build,
   the demo, inspects the journal — then approves or lists defects.
7. **Operator** merges to main and updates this ledger.
8. Switching windows mid-phase is fine IF the "In flight" row above is filled
   in first (branch, tip commit, what remains). An empty "In flight" means a
   clean handoff.

## New-window checklist (any role)

1. Read this file.
2. Read the current phase plan doc (`docs/phase-3-plan.md` right now;
   Phases 4–5 exist as rough outlines in `docs/phase-4-rough.md` /
   `docs/phase-5-rough.md`).
3. `git log --oneline -10` and `git status` — tree must be clean, branch known.
4. `npx vitest run` and `npm run build` — must be green before any work starts.
5. Follow the review loop above. Never work directly in main's tree.

## Scars — rules written from real incidents

- **The gitignore incident:** an unanchored `db/` pattern silently kept
  `engine/db/` out of Phase 0's commits; main could not build. Anchor ignore
  patterns (`/db/`, `/.bureau-worktrees/`), and after any oddity run
  `git status --ignored` and check source dirs are tracked.
- **The uncommitted-main incident:** a whole milestone sat as untracked files
  in main's working tree. Branches are mandatory; "done" means committed on a
  stream branch and merged by the Operator.
- **The live-DB incident:** a demo wrote a fake queued task into
  `db/bureau.db`. Tests and demos use temp paths only and clean up after
  themselves; the live DB is bureau property.
- **The fake-mutation incident:** a "mutation test" that filtered its own
  input proved nothing. A mutation means: mutate the real code, watch a real
  test fail, restore, record the logs.
- Claims in walkthroughs are verified, never trusted. Suite runs twice (flake
  check), build, demo, journal inspection.

## Standing invariants (all phases)

One SQLite store (boot-migration via `ADDED_COLUMNS`); nothing fire-and-forget
(every async step is a job row); budgets are columns incremented
transactionally with the state they bound; one journal door with full
attribution; API keys live in env only; no network in tests; verify commands
are bureau-owned and never read from a workspace; the DB refuses what the
rules forbid (CHECK constraints), and no code path bypasses it.
