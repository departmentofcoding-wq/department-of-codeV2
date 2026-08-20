# Walkthrough — Flow Integration (`wt/junior-a-flow-integration`)

**Junior:** window driving `wt/junior-a-flow-integration`, cut from `main` at
`1ee4c6f`. Every claim below is re-runnable; the Senior should re-run the
representatives, not trust this text.

## What this stream fixes (thirteenth-man review findings)

1. **The flow is integrated.** The plan-review cycle is now a real `plan.cycle`
   job kind with the legacy job's guards, closing the "parallel universe" gap:
   - state gate (only `queued`/`claimed` may plan; anything else → guardrail
     span + refusal);
   - `plan_rounds` ceiling entry-guard (refuse → guardrail span → task blocked →
     operator notified, BEFORE any agent work);
   - deterministic rubric pre-gate (a plan missing branch/scope/tests+mutation/
     walkthrough is amended at zero senior cost — including the junk-transcript
     fallback case);
   - approve **continues the pipeline**: `bureau_dispatches` row + `junior.dispatch`
     job whose prompt embeds the approved plan, targeted at the same junior;
   - revise **actually cycles**: the next `plan.cycle` round is enqueued with the
     senior feedback verbatim, relayed into the junior's next prompt;
   - the junior's plan prompt now states the department plan standard up front.
2. **Verdict integrity.**
   - `parseVerdict` is genuinely fail-closed: no explicit `VERDICT:` marker →
     revise, always (the old heuristic approved "I don't think this should be
     approved as-is");
   - a stalled/aborted/timed-out agent wait is a hard error (`ensureCompleted`)
     — a partial transcript is never parsed into a review;
   - the ZCode senior reads a 400-line window (was 60), so the first-line
     `VERDICT:` marker survives long reviews.
3. **Cancellation honors the machinery.** `waitForAgentIdle` takes an
   `AbortSignal` (checked every poll); the signal flows job → dispatch-job →
   seam → wait. `junior.dispatch` timeout raised 120s → 30 min (the old ceiling
   only "worked" because the CDP path ignored its signal); `plan.cycle` is
   45 min, single attempt (no automatic re-prompting of live agents).
4. **Honest attribution.** Plan/review rows record the real model label
   (GUI picker read-back / CLI `--model`) or the sentinel `unspecified` — never
   a fabricated `junior-A`/`claude`.
5. **Harness hardening.** Fresh-conversation is strict (a missing New-chat
   control fails the run instead of risking stale-context bleed); mid-plan
   timestamps no longer truncate extracted blocks; folder matching is tiered
   (exact → prefix → substring); the Claude CLI timeout kills the process tree
   on Windows (`taskkill /T`, was: kill the shell only).
6. **Live-DB hygiene (executed, with backup).** `scripts/cleanup_live_db.ts`
   (dry-run default, `--apply` writes a backup first) killed the 5 stranded
   task-scoped pending jobs (incl. the two armed `junior.dispatch` rows) and
   blocked the stuck `claimed` task `live-mt0xey1w`. Console standing rows
   (`console-*`) intentionally untouched. Backup:
   `db/backups/bureau.db.backup-2026-08-20T16-23-40-478Z`. Every change is a
   journaled system span.

## Files

- `engine/flow/plan_review_cycle.ts` — integrated cycle (guards, rubric, loop, continuation)
- `engine/harness/agent-wait.ts` — `signal`, `ensureCompleted`
- `engine/harness/antigravity-seam.ts` — signal/stall semantics, strict fresh conversation
- `engine/harness/antigravity.ts` — timestamp-tolerant blocks, tiered folder match
- `engine/harness/senior.ts` — fail-closed parse, stall errors, wide window, tree-kill, model label
- `engine/harness/dispatch-job.ts` — signal passthrough
- `engine/jobs/registry.ts` — `plan.cycle` job kind; `junior.dispatch` timeout
- `scripts/run_plan_cycle.ts` — enqueues + drains the job (was: direct call)
- `scripts/cleanup_live_db.ts` — new, auditable live-DB residue cleanup
- Tests: `tc_plan_cycle` (9), `tc_senior` (14), `tc_agent_wait` (7), `tc_antigravity` (14)
- Docs: `docs/mutation-evidence-phase7.md`, this walkthrough, `docs/senior-integration.md` updates

## Claims to verify

- **Suite:** `npx vitest run` → 281/281 across 73 files, run twice (flake check).
- **Build:** `npm run build` → clean.
- **Mutations:** `docs/mutation-evidence-phase7.md` M-F1..M-F4, each with the
  exact mutation and the single test that failed — re-execute representatives.
- **Live-DB state:** `db/bureau.db` has no task-scoped pending jobs;
  `live-mt0xey1w` is `blocked` with a `transition` span; backup file exists.

## Explicitly NOT done (operator decisions, not mine to take)

- **Verdict backfill for `03985ef`:** the settings-tab merge reached main on a
  plan approval + the junior's self-verification; no walkthrough review was
  posted for the implementation hash. Running
  `node --experimental-strip-types scripts/run_senior.ts --senior zai --kind walkthrough …`
  retroactively (or recording an explicit operator override) is the Operator's call.
- **The skip-review exemption rule** ("direct on main" for harness work that
  creates the reviewers) should be written into the ledger by whoever merges,
  as a narrow, logged exemption — not a habit.
- First LIVE `plan.cycle` run (real GUI agents through the job) is Phase 7 C1
  scope; this stream's live verification is the cleanup script execution above.
- ZCode side-pane verdict capture (GLM's deep audit lands outside the main
  transcript) remains an open calibration item, unchanged by this stream.
