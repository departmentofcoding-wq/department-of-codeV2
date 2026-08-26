# Walkthrough — A1: merge-law enforcement + delivery-tail regression lock

**Branch:** `wt/a1-reconciliation-mergehook` (cut from `main` = `562d2a9`)
**Stream:** Part A / A1 of `docs/plan-bureau-kernel-roadmap.md`
**Author:** operator-assist session

## What this stream does

Closes the code half of A1 (workspace reconciliation → tracked delivery). The
roadmap review found the delivery tail was already wired end-to-end in code but
(1) only covered per-stage, never seam-joined, and (2) the merge law was prose +
review discipline with **no tooling** — the exact gap behind the 2026-08-24
out-of-band-merge scar. This stream adds the tooling and the regression lock.

### New files
- `engine/delivery/merge_guard.ts` — pure, DB-reading predicate
  `mergeAllowed(db, tip)`: a commit is blessed iff a Senior-approved
  `bureau_work_reviews` row names exactly that `reviewed_commit` AND the owning
  task reached the done-gate (`state='done'`, `merged_at` set). No git, no I/O.
- `scripts/merge_guard_hook.ts` — the git-hook layer. `decideHookOutcome` and
  `decideRefUpdate` are factored pure and unit-tested; `runMergeGuardHook`
  (pre-merge-commit/pre-commit) and `runReferenceTransactionGuard`
  (reference-transaction) wire git inputs + journal the outcome. Fail-closed on
  the protected branch if the DB can't be consulted. The **reference-transaction**
  hook closes the fast-forward bypass — it fires on ANY update to `refs/heads/main`
  (fast-forwards and resets included, which create no commit and so never trigger
  the pre-*-commit hooks), while still allowing a `git pull` of history already
  delivered on the remote (a new tip contained in `origin/main`).
- `scripts/install_git_hooks.ts` — idempotent installer (`npm run hooks:install`)
  that writes LF-only `pre-merge-commit`/`pre-commit` wrappers, refuses to
  clobber a non-bureau hook, sets `merge.ff=false`, and journals the install.
- `test/unit/tc_merge_guard.test.ts` — 10 tests (predicate + hook decision).
- `test/integration/t45_delivery_tail.test.ts` — the seam-joined tail.

### Modified
- `package.json` — adds `hooks:install`.
- `docs/mutation-evidence-phase7.md` — M-MERGE-1 recorded.

## Claims (for independent senior verification)

1. **Suite green:** `446 tests / 96 files` pass; `npm run build` (`tsc --noEmit`)
   clean. Baseline was 435/94 → +11 tests, +2 files. (Run `npx vitest run` and
   `npm run build`.)
2. **T45 proves the tail seam-joined:** from a walkthrough APPROVE, draining
   only the job queue + the operator door (`approveTask`) carries a task
   `worktree.prepare → verify.run → needs-review → pr.create → pr.merge → done`,
   with `reviewed_commit` = the junior's real tip, `merged_at/by` set, all four
   delivery jobs `done`, and a `transition`/`action:merge` span present — **no
   direct state writes**.
3. **Mutation evidence M-MERGE-1 is real:** dropping `reviewed_commit = ?` from
   the guard's approved-review lookup made a forged commit blessed, and
   `tc_merge_guard` "refuses a forged commit…" failed (`expected true to be
   false`); restored → 5/5. (Recorded in the mutation-evidence file.)
4. **The hook refuses out-of-band merges — proven live** (throwaway repo, hooks
   pointed at this script, temp DB), for BOTH paths:
   - `git merge --no-ff feature` into `main` → **refused** (guardrail span), main
     unchanged;
   - `git merge --ff-only feature` (the fast-forward bypass) → **refused by the
     reference-transaction hook** in the `prepared` phase, main unchanged;
   - `BUREAU_ALLOW_MERGE=1 git merge --ff-only …` → **allowed**, journaled as an
     override span (never silent).
   Verified via the temp DB's `bureau_journal` (refused + override spans).

## Notes / honest limitations

- On the git version tested, `MERGE_HEAD` is not exposed at `pre-merge-commit`
  time (only `AUTO_MERGE`), so the incoming tip isn't always resolvable in that
  hook. That is not a defect: any **local** non-ff merge into `main` is
  out-of-band (the tracked path merges on the remote), so pre-merge-commit
  fail-closed-refuses it. Fast-forward advances (which resolve no MERGE_HEAD and
  create no commit) are handled by the **reference-transaction** hook instead,
  which evaluates the actual new tip against `mergeAllowed` and the remote.
- **Fast-forward gap (senior REVISE, round 1) — CLOSED.** The first submission
  only had pre-merge-commit/pre-commit, which a `git merge --ff-only` bypasses.
  The reference-transaction hook was added to catch fast-forward/reset advances
  of `main`; proven live (ff refused, override allowed). See
  `docs/reviews/verdict-a1.md`.
- **Scope (senior round 2, non-blocking):** the guard is **local-clone-scoped** —
  it only fires in a repo where `npm run hooks:install` has run. A merge via the
  GitHub UI, or from a fresh clone that never installed the hooks, produces no
  refusal. This matches the task (a git hook) and the actual 2026-08-24 scar (a
  local hand-merge in this repo); server-side branch protection is a separate,
  future control.
- **Not yet done (operator/live steps of A1, intentionally out of this stream):**
  installing the hooks in *this* repo (`npm run hooks:install`), the live
  intake→`done` run capture, and lifting the hand-merge pause in
  `docs/DEPARTMENT_STATUS.md` + `AGENTS.md`. Those are operator acts to run after
  this stream is senior-approved and merged through the tracked path.
