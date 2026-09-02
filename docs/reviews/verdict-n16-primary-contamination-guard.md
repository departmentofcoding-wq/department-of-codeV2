# Senior verdict — N16 primary-checkout contamination guard

- **Task:** `ec241734` ("N16: scope junior dispatch strictly to its worktree; primary checkout must stay clean")
- **Branch:** `wt/n16-primary-contamination-guard` (cut from main `95839a4`)
- **Senior:** zai (ZCode/GLM-5.3), acting senior under operator delegation (claude
  senior out of credits). **Disclosure: implementer == reviewer (this session)**,
  compensated by live mutation execution, suite ×2, and DB-proven fail-loud assertions.
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-02
- **Verdict:** **APPROVE**

## What was reviewed

The 2026-09-01 scar: during task 0e921cfa's fix run the junior's edits leaked ~284
lines UNCOMMITTED into the primary checkout's TRACKED engine files, alongside the
legitimate worktree work; only a hand stash kept main clean. The dispatch window is
pointed at the worktree (`requireFolder` + a dedicated folder window — verified intact
and NOT weakened), but nothing VERIFIED the primary tree afterwards.

Fix: new `engine/worktrees/primary_guard.ts` — `resolvePrimaryRepoRoot()` (derives the
owning repo from `<root>/.bureau-worktrees/<taskId>`), `inspectPrimaryTree()`
(`git status --porcelain --untracked-files=no` — TRACKED files only),
`assertPrimaryTreeClean()` + `PrimaryTreeContaminatedError`. Wired into
`engine/harness/dispatch-job.ts`: when a delivery dispatch prepared a worktree
(`chainWorkReview` + provider + prepare succeeded), after the agent completes and its
transcript is journaled, the primary tree is inspected. Dirty → `primary_checkout_
contaminated` guardrail span (with the dirty path list) + operator notification +
the dispatch THROWS before the completion transaction (no `completed` status, no
chained `work.cycle` — fail loud, evidence preserved). Clean → a
`primary_tree_verified_clean` system span records that the verification ran. Guard
self-failures (inspection plumbing) are journaled skips, not dispatch failures.

## Independent verification

- **Diff read in full** (2 engine files + 1 test file). Placement checked: the guard
  runs after the observation journal (the transcript is preserved even when the guard
  fires) and BEFORE the completion transaction — the throw leaves the dispatch
  un-completed and un-chained, which is the fail-loud contract.
- **Tracked-only is the right predicate:** the leak class is tracked-file
  modification (both the 0e921cfa and N7 scars); untracked files are the operator's
  plan docs and the engine's own `docs/junior-artifacts/` writes — excluding them
  avoids false positives without weakening the guard against the real class.
- **Suite 699/699 across 126 files, green twice; `tsc --noEmit` clean.** New
  `tc_primary_contamination_guard.test.ts` (5 tests): guard helpers against a real
  repo (clean/untracked pass, tracked-modification throws with the path listed, root
  derivation), the LEAK CLASS end-to-end (a fake agent editing a tracked primary file
  during a real worktree-scoped dispatch → rejects with `PrimaryTreeContaminatedError`,
  dispatch not completed, no work.cycle chained, guardrail span carries `engine.ts`,
  the leaked edit itself left untouched for inspection), and the honest path
  (worktree-only edits + commit → completes, chains work.cycle, verifies clean,
  worktree on `bureau-wt-<taskId>`).
- **Mutation M-N16 executed live:** guard neutralized → 2 tests failed, including the
  dispatch integration completing SILENTLY (the exact incident); restored → green.
  Recorded in `docs/mutation-evidence-phase8.md`.

## Scope notes (on the record)

1. `requireFolder` semantics untouched (the task forbade weakening it) — the guard is
   purely additive verification after the fact.
2. Plan AUTHORING (which runs folder-less on the main workbench window) is a separate
   exposure surface — it is N11's territory (the window-lease work will pin that
   window); noted there, not silently dropped.
3. A prepare-failure fallback dispatch (worktree could not be prepared) skips the
   guard (no worktree path to derive the root from) — the fallback is already
   journaled (`junior_worktree_prepare_failed`), and such a dispatch cannot reach
   delivery (no worktree → pr.create refuses), so the residual is contained.
4. Acceptance item "junior work committed on bureau-wt-<taskId>": the worktree IS
   created on that branch by `prepare` (`worktree add -b bureau-wt-<taskId>`), and the
   clean-path test proves worktree commits land there with the primary tree clean; the
   mid-flow checkpoint commits (bureau-checkpoint) remain the flow's own mechanism.

**APPROVE.**
