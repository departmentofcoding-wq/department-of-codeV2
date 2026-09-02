# Senior verdict — N3: wire the junior assignment policy into every flow door

- **Branch:** `wt/junior-a-n3-junior-assignment` (tip `66f64c4`)
- **Base:** `d9b8152`
- **Senior:** claude (Claude Code CLI, `claude -p --append-system-prompt`, adversarial
  static/close-read review — the `claude -p` sandbox cannot run the suite, so the senior
  reasoned from the full diff + tests + independently-supplied evidence)
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-01
- **Verdict:** **APPROVE**

## Provenance / validity
This verdict replaces the voided 2026-09-01 phantom-verdict attempt (the zai/ZCode run
that self-attached to port 9335 and scraped the working session's own transcript — see
`docs/plan-n3-junior-assignment.md` §"Senior review"). This claude review is a genuine
independent subprocess: the claude senior parallelizes as its own process and has no
circularity with the working session. The prior `claude` OAuth block was cleared by the
operator (re-login) before this run.

## What was reviewed
The N3 fix: `assignJunior({ taskId })` — deterministic by task id, honoring an explicit
pin and `JUNIOR_DEFAULT` — is now the fallback at every flow door that resolves an
unpinned junior, replacing the hardcoded `(opts.junior || 'A')`:
- `engine/flow/plan_review_cycle.ts:278` (plan authoring; the resolved id propagates into
  the implementation dispatch payload).
- `engine/flow/work_review_cycle.ts:396` (the REVISE fix dispatch).
- `engine/verify/loop.ts:100` (the N1(b) stale-approval re-review enqueues `work.cycle`
  with `junior` pinned explicitly).
Root cause: `assignJunior` had **zero production callers** on the base (`d9b8152`) — the
auto-kickoff chain never invoked it, so `|| 'A'` was the de-facto policy and the first
2-concurrent run put both `3756ec6e` and `b55e2fda` on junior A. New integration test
`test/integration/tc_junior_assignment.test.ts` (6 tests); mutations M-N3a/b/c in
`docs/mutation-evidence-phase8.md`.

## Senior's findings (verbatim summary)
- **Coverage is complete.** Traced every unpinned-junior enqueue site — auto-kickoff
  (`fileTask` → `plan.cycle` → `plan_review_cycle`), both REVISE loops, the ceiling-proceed
  path, `dispatch-job.ts` `chainWorkReview` forwarding, the stale-approval re-review, the
  verify-failure sendback, and the self-healing `rekick.ts`/`reconcile.ts` re-enqueues. The
  three doors in the diff are the only production sites that defaulted to `'A'` for
  *selection*. The residual `?? 'A'` at `dispatch-job.ts:246` is a **journal-detail**
  default (observability after the run), not a selection path — `payload.junior` is always
  populated by the time the driver runs.
- **Determinism holds across phases** without a persisted column: `assignJunior` is pure in
  `taskId`, and the REVISE loop re-pins `junior: p.junior` on the next round rather than
  re-deriving (belt-and-suspenders); `dispatch-job.ts` forwards `payload.junior` verbatim
  into the chained `work.cycle`.
- **Verify-failure sendback correctly omits junior** (`verify.run` re-enqueue carries
  `{taskId}` only — the verifier drives no junior). Mutation-evidence claim accurate.
- **Hash verified independently** by hand (parity shortcut: 31 is odd, so the A/B parity is
  the XOR of per-char parities; mod-2³² truncation preserves parity): `3756ec6e-…` → A,
  `b55e2fda-…` → B — matches the implementer, confirming `TASK_B` is a genuine B-hash and
  the new tests really fail under the old `|| 'A'`, not tautologically.
- **Regression risk low.** Explicit pins and `JUNIOR_DEFAULT` are checked first and win
  everywhere (dedicated "pinned junior still wins" test); `rekick`/`reconcile`'s bare
  `{taskId}` payloads correctly fall through to the same deterministic resolution.
- **No overclaims** in the walkthrough/mutation-evidence relative to the diff and tests.

## Independent operator verification (this session)
- `tsc --noEmit` clean on the branch.
- `test/integration/tc_junior_assignment.test.ts` — **6/6 pass** (re-run live).
- Base-commit grep confirmed: zero `assignJunior` production callers on `d9b8152`.
- Full suite re-run recorded at merge (see ledger).
