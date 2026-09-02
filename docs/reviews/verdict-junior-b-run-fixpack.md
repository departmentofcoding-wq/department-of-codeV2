# Senior verdict — Junior-B run fix pack (F1 N16 baseline, F2 prompt continuity, F3 port-wedge recovery)

- **Branch:** `wt/junior-b-run-fixpack` — reviewed feature commit `467ae5f`
  (all engine + test changes; this verdict doc and the rename-case unit pin
  ride a docs/test-only follow-up commit on top, addressing the senior's one
  minor finding — no engine changes after the reviewed hash)
- **Against:** main `796e6ac`
- **Reviewer:** claude senior (independent subprocess, `claude -p` headless
  agentic — file reads + greps + live vitest/mutation runs in this repo; the
  implementer is a different session, ZCode/GLM-5.3)
- **Kind:** engine-dev code-diff review of the full change (12 files: 6 engine,
  5 test, mutation evidence)
- **Date:** 2026-09-02
- **Plan:** `docs/plan-junior-b-run-fixpack.md` (untracked, operator's call)
- **Mutations:** M-F1/M-F2/M-F3 (`docs/mutation-evidence-phase8.md`)

## Context

The first live N9 delivery through junior B (Antigravity 2.0, single-window)
proved the B delivery fix but exposed three defects: the N16 primary-tree guard
failed the innocent dispatch over the operator's PRE-EXISTING uncommitted
ledger edit (absolute clean check, no baseline); the implementation dispatch
landed in a blank conversation after B's mid-flow restart and re-explored from
scratch, wasting tokens; and the "port dead + single-instance lock" wedge was
not auto-recovered, burning dispatch attempts until a manual kill-all.

## Verdict

**APPROVE** — zero blockers, zero majors. One minor (no explicit rename-case
unit test; behavior verified manually by the reviewer with `git mv`) — addressed
in the follow-up commit. One nit (the production default `recover` callback is
not exercised by tests — pre-existing practice, every test injects its own
`recover`; the live rekick is the real proof and stays operator-gated).

Independently verified by the reviewer (from source, not the commit message):

1. **F1** — `snapshotPrimaryTree`/`changedAgainstBaseline` correctly baseline
   pre-dispatch dirt and diff by content oid; genuine new leaks (new path, or
   further-changed pre-dirty path) still fail loud. Confirmed by the 3 new
   integration tests and by **live mutation M-F1**: reverting to the absolute
   `Object.keys(after.dirty).sort()` failed exactly the N9-false-positive test,
   reproducing the live incident verbatim; restored → green, tree clean.
2. **F2** — handle line + CONTEXT preamble prepended in all four prompt
   builders; the N0 completion sentinel remains the LAST token of the
   implementation/fix/verify-fix prompts and is absent from plan authoring
   (N13 preserved); revision-round plan prompts quote the junior's previous
   plan from `bureau_plans.plan_text`.
3. **F3** — the port-timeout wedge class matches exactly
   `ensureJuniorRunning`'s message and does NOT match the failed-recovery or
   absent-install messages; recovery stays bounded to exactly one heal.
   Confirmed by **live mutation M-F3**: dropping the port regex failed all 3
   F3 tests with exactly the N9 symptom (attempts burned, `recover` never
   called); restored → green.
4. Full suite **735/735 in a single run**, `tsc --noEmit` clean, and the
   `t38_demo_phase3` strip-types canary green (the `type` modifier on the
   `PrimaryTreeSnapshot` import is the only such import site, correctly fixed).
5. `changedAgainstBaseline` correctness holes checked: deletions, repoRoot
   mismatch (conservative), staged-vs-unstaged (not a hole — the guard hashes
   working-tree content, which is what it polices).

Merge is the operator's call (hand-merges stay paused per the standing law);
this branch is delivery-ready.
