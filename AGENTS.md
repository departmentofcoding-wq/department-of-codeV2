# Department of Code v2 — Session Bootstrap

You are working in the Department of Code, an LLM-driven software bureau.
Before doing anything else:

1. **Read `docs/DEPARTMENT_STATUS.md`** — the department's memory across
   sessions. It says which phase is current, what is in flight, and the
   operating protocol.
2. Read the current phase plan it points to (e.g. `docs/phase-2-plan.md`).
3. Check `git log --oneline -10` and `git status`, then run
   `npx vitest run` and `npm run build`. Main must be green before work starts.

Core rules, non-negotiable:

- **Never work directly in main's working tree.** One branch per stream
  (`wt/junior-<x>-<stream>`), one PR per milestone; the Senior reviews, the
  Operator merges.
- **Merge discipline (the Phase 2 law).** Nothing reaches `main` — no commit,
  no merge, no fast-forward, docs and review artifacts included — until a
  Senior verdict is posted for that exact commit hash. Junior work is
  committed on the stream branch, never left uncommitted in a checked-out
  tree. A ledger "done" row cites the hash that actually contains the work,
  and walkthrough citations (branch, commit, test counts, demo output) must
  match reality — the Senior re-runs them. Phase 2 recorded five violations
  of this rule; every one was caught and repaired, and the rule is absolute
  from Phase 3 on.
- **No out-of-band delivery — every merge to `main` is a tracked department
  act.** A merge (or any commit to `main`, artifacts included) must leave a
  record in the department's own machinery: a `bureau_jobs` row, a `journal()`
  span, and the task's state transition — i.e. it travels the delivery path
  (`verify.run → needs-review → operator approve → pr.create → pr.merge → done`,
  with `merged_at`/`merged_by` set). A human or a peer session **must not**
  `git merge`/`git commit` to `main` by hand outside that flow. Real incident
  (2026-08-24): the two shipped tasks (`82b97764`→`c7f9b37`, `e489b734`→
  `1c14534`) and their `docs/junior-artifacts/` transcripts were merged/committed
  to `main` by hand — leaving the DB with **zero** `verify.run`/`pr.create`/
  `pr.merge` jobs, zero merge journal spans, and the task rows stranded at
  `queued`/`claimed`. Root cause: the harness junior works in its own IDE
  workspace, not a bureau worktree, so `verify.run` can't run against its branch
  and the tracked path is never reached (the "workspace/worktree reconciliation"
  stream in `docs/DEPARTMENT_STATUS.md`). **Until that stream lands, hand-merges
  are paused:** finish work on its `wt/...` branch and leave it for the operator;
  do not merge to `main` outside the tracked flow.
- The invariant lives in the database: done requires verifier exit 0 AND human
  approval. No code path bypasses what the DB refuses.
- Every asynchronous step is a row in `bureau_jobs`. Nothing fire-and-forget.
- Budgets are columns (`plan_rounds`, `verify_fixes`, `cycles`, `attempts`),
  incremented transactionally with the state change they bound.
- One journal door: every act writes an attributed span via `journal()`.
- API keys live in environment variables only — never in the DB, journal,
  messages, or logs.
- Tests never touch the network or the live `db/bureau.db`; they use temp
  paths and clean up.
- Every PR names the guard it broke and the test that caught it: real mutation
  evidence, recorded in `docs/mutation-evidence-phase<N>.md`.
- Claims in walkthroughs get verified (suite twice, build, demo, journal), not
  trusted.

Key paths: `engine/` (contract, db, jobs, journal, ledger, models, llm,
officers, intake, filing, state, verify, worktrees), `runner/main.ts` (job
loop + `drainSingleJob` + provider wiring), `scripts/` (`intake.ts` CLI,
`demo_phase1.ts`, `demo_phase2.ts`, `smoke_llm.ts`), `test/` (unit +
integration, numbered T-records; `test/helpers/` fakes; `test/fixtures/`
db factory), `docs/reviews/` (peer-review artifacts).
