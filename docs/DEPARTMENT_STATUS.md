# Department of Code v2 — Department Status Ledger

**This file is the department's memory across sessions and windows.** Every new
session (Senior, Junior, or Operator) reads this file FIRST, then the current
phase plan, then git. Nothing important lives only in a chat window.

---

## Current status

| | |
|---|---|
| **Phase** | **Phase 2 — Worktrees + Verifier: COMPLETE** |
| Main | `main` — Stream A (Worktrees) and Stream B (Verifier) merged (`d383673`) |
| Suite | 124/124 tests, 34 files, `npm run build` clean — verified on main |
| In flight | Phase 2 complete — ready for Phase 3 (Junior harness) |
| Next action | Begin Phase 3 planning |

## Phase ledger

| Phase | Scope | Status |
|---|---|---|
| 0 — Foundation | Engine package, full schema (budgets as columns), jobs runner with claim/lease/reap, journal, migration door | ✅ done, merged |
| 1 — Intake | Filing door, intake sessions, Task Intake Officer over Ollama/Gemini, `intake.turn` job, CLI, durability, T9–T18 | ✅ done, merged (`cf0901f`), exit demo verified |
| 2 — Worktrees + Verifier | Worktree manager, checkpoints, deterministic verifier, verify→fix loop bounded by `verify_fixes` | ✅ done, merged (`d383673`), full exit sentence verified |
| 3 — Junior harness | CDP client, selector registry + calibration gate, nonce correlation, window lease | pending |
| 4 — Senior + gates + delivery | Plan/work review, operator approval, PR creation, merge with worktree cleanup | pending |
| 5 — Hardening | Watchdog, backup push, Secretary, dashboards, red-team checklist | pending |


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
2. Read the current phase plan doc (`docs/phase-2-plan.md` right now).
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
