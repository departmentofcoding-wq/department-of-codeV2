# Walkthrough — Completed/Done tag for shipped tasks + out-of-band-merge rule

**Branch:** `wt/task-completion-tag`
**Commits under review:**
- `f371354` — feat(console): tag shipped/finished tasks as Completed (done-gate-safe)
- `1929bf9` — docs(flow): forbid out-of-band merges to main; record the incident + rule

**Base:** `main` @ `17cdb15` (already contains the merged archive/flow + senior-reuse work, `27b85e5`/`60be286`).

---

## Why

Two operator requests:
1. **"If something has been shipped and done it should be tagged as completed or done."** Shipped-out-of-band work (delivered via the Senior review+merge path) had no honest way to read as done: its DB row never travelled the verify/approve door, so a state-machine `done` is forbidden by the absolute done-gate CHECK.
2. **"We can't have something just auto merging — it should be part of the dept with history and job tracking."** Investigation of why merges land on `main` outside the tracked flow, and a rule to stop it.

## What changed — commit `f371354` (Completed tag)

A first-class **completion tag**, orthogonal to the state machine (same pattern as archive), so shipped work reads as **✓ Completed** without forging `done`.

- **Schema** (`engine/db/schema.ts`): `completed_at`, `completed_by`, `completion_commit`, `completion_note` added in all three places — base `CREATE TABLE`, `ADDED_COLUMNS` boot migration, and the legacy-rebuild path (CREATE + INSERT/SELECT column lists). Completion never writes `state`; the done-gate CHECK is byte-unchanged.
- **Engine** (`engine/state/completion.ts`): `markTaskCompleted` / `reopenTask` — human-operator-gated, transactional, idempotent (state-guarded `UPDATE … WHERE completed_at IS NULL … RETURNING`), one journaled `human` span per act, records the shipping commit.
- **Console** (`console/server.ts`, `console/contract.ts`): `GET /api/tasks/completed`; `POST /api/tasks/:id/complete`; `POST /api/tasks/:id/reopen`. Refusals journal a `guardrail` span **without** a `taskId` (FK-safe for unknown ids). The live list (`GET /api/tasks`) and the dashboard/flow projections now exclude **completed AND archived** (active work only). `ENDPOINTS` manifest 24 → 27, count test updated.
- **Frontend** (`console/public/*`): Tasks header is a **Live / Completed / Archived** segmented control; live rows gain a **Complete** action; the Completed view shows a green **✓ Completed** badge, the shipping commit, the note, and **Reopen**.

## What changed — commit `1929bf9` (out-of-band-merge rule, docs only)

- `AGENTS.md` core rules: new non-negotiable — every merge to `main` is a tracked department act (bureau_jobs row + journal span + task state transition); no hand-merges/commits to `main` outside the flow; hand-merges paused until workspace/worktree reconciliation lands.
- `docs/DEPARTMENT_STATUS.md` scars: "The out-of-band-merge incident" recorded with the evidence.

## Investigation findings (the "why is it outside the flow" answer)

Evidence from the live `db/bureau.db` for both shipped tasks (`82b97764`, `e489b734`):

| Signal | Expected (tracked flow) | Actual |
|---|---|---|
| `bureau_worktrees` rows | ≥1 | **0** |
| `verify.run` jobs | ≥1 | **0** |
| `pr.create` / `pr.merge` jobs | 1 each | **0 (never enqueued, ever)** |
| merge journal spans | 1 | **0** |
| jobs that ran | — | `plan.cycle`, `junior.dispatch`, `work.cycle` only |

Root cause: the harness junior works in its own IDE workspace, not a bureau worktree → no worktree row, so `verify.run` never runs → task never reaches `needs-review` with `verifier_exit_code = 0` → `approveTask` can't fire → `pr.create`/`pr.merge` never enqueued → the branch and the `docs/junior-artifacts/` transcripts are merged/committed to `main` **by hand** (a peer session). No git hook, cron, or scheduled task is involved (verified). This is the documented "workspace/worktree reconciliation" gap.

## Claims to verify (please re-run, don't trust)

1. **Suite + build.** `npx vitest run` → **384/384** across 88 files; `npm run build` (`tsc --noEmit`) clean. (Baseline before this branch was 375/375 on merged main; +9 net from the completion stream.)
2. **Done-gate not bypassed.** `test/unit/tc_task_completion.test.ts` includes "does NOT let completion forge a done: the done-gate CHECK still bites" — completing a `claimed` task, then `UPDATE … SET state='done'` throws. Zero `done`-state rows exist in the live DB.
3. **Orthogonal to state.** Completing a task leaves `state` unchanged (asserted in engine + API tests); the live DB shows the two completed tasks still at `queued`/`claimed`.
4. **Fail-closed.** Non-operator role refused; unknown task → `COMPLETE_REFUSED` + guardrail span; no-token → 401 (`test/unit/tc7_archive_flow_api.test.ts`).
5. **Buckets.** `GET /api/tasks` excludes completed+archived; `/api/tasks/completed` returns only completed; `/api/tasks/archived` only archived (API test).
6. **Live DB reconciliation.** Backup `db/backups/bureau.pre-complete-*.db` exists. Final live state: **2 completed** (`82b97764`→`c7f9b37`, `e489b734`→`1c14534`, with `completion_commit` set), **2 archived** (the "Add subtract()" test artifacts), **0 live**, **0 forged `done`**. `scripts/reconcile_live_tasks.ts` is idempotent (re-run = no-op) and journaled.
7. **UI.** Rendered live in a browser against the live DB: the Completed tab shows both shipped tasks with the ✓ Completed badge, commit, note, and Reopen.

## Mutation evidence

Junior-side mutation evidence for this stream is not yet recorded in `docs/mutation-evidence-phase7.md` (flagging honestly; the archive/flow stream's M-ARCH/M-SENR were Senior-executed). Suggested mutations for the Senior to execute: (a) drop the `actor_role !== 'human-operator'` guard in `markTaskCompleted` → the operator-gate test fails; (b) change the live-list query to omit `completed_at IS NULL` → the "moves from live to completed" API test fails.

## Scope notes

- This is a **tag**, not a delivery mechanism. It makes shipped work *read* as done; it does **not** merge anything or reach state-machine `done`. The real fix for tracked delivery (workspace/worktree reconciliation so tasks reach `done` through the door) remains the next stream per `docs/DEPARTMENT_STATUS.md`.
- Per commit `1929bf9`, this branch was **not** hand-merged; it is left on `wt/task-completion-tag` for the operator.
