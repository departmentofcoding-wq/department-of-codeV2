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
officers, intake, filing, state), `runner/main.ts` (job loop +
`drainSingleJob`), `scripts/` (`intake.ts` CLI, `demo_phase1.ts`,
`smoke_llm.ts`), `test/` (unit + integration, numbered T-records).
