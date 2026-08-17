# Department of Code v2 — Phase 2 Plan: Worktrees + Verifier

Handoff document for the two Junior Engineers. Senior Engineer: GLM-5.2
(Z.ai/ZCode). Every milestone ends in a pull request the Senior reviews; the
Human Operator approves and merges. Phase 2 adds **no LLM calls, no IDE
automation, no review gates** — worktrees and the Verifier are pure
TypeScript. The exit sentence:

*A queued task is claimed into a clean worktree at a recorded base; its
human-confirmed verify command runs scrubbed, timeout-bounded, and
bureau-owned; failure sends it back — checkpointed — until the `verify_fixes`
ceiling, then a human is rung; success leaves it in `needs-review` with every
run attributed; and killing the runner mid-verify loses nothing.*

---

## 0. Ground rules (all of Phase 1's, plus)

Read `AGENTS.md` and `docs/DEPARTMENT_STATUS.md` first; the scars listed
there (anchored gitignore patterns, branches mandatory, temp-DB-only tests
and demos, real mutation evidence) are standing law.
- **Branches:** `wt/junior-a-worktrees` and `wt/junior-b-verifier`, cut from
  `main` after W0 merges. One PR per milestone.
- **Schema:** new tables go in the base DDL as `CREATE TABLE IF NOT EXISTS`
  (idempotent at boot, as Phase 1 did for the intake tables); new columns on
  existing tables go through `ADDED_COLUMNS` in `engine/db/schema.ts`. Every
  schema change ships a migration test that boots an old-shaped database and
  verifies the new shape — the boot-migration path stays dogfooded.
- **The verify command is bureau-owned.** The Verifier reads `verify_cmd`
  from `bureau_tasks` only — never from a file in the workspace. This is the
  Phase 5 red-team rule, baked in on day one.
- **Budgets are columns:** `verify_fixes` already exists on `bureau_tasks`
  (Phase 0); it is incremented in the same transaction as the send-back state
  change, never from journal archaeology.
- **The workspace seam is the contract.** Stream B tests against a
  `FakeWorkspaceProvider` (temp directories); Stream A owns the real git
  implementation; they meet only at milestone WX.
- **No network in tests.** Real git and real child processes in temp
  directories are encouraged — they are the point.
- **The mutation rule, unchanged:** every PR names the guard it broke and the
  test that caught it; evidence in `docs/mutation-evidence-phase2.md`.

## 1. Model roster for this phase

| Role | Backend | Cost |
|---|---|---|
| Worktree manager, Verifier, send-back loop, all gates | Pure TypeScript | free |
| Everything else | unchanged from Phase 1 | — |

Zero model calls are spent in Phase 2. If a design seems to need one, it
belongs in a later phase.

## 2. Milestone W0 — contract freeze (half a day, blocks both streams)

One PR into `main`, both juniors review, then freeze:

- **State machine additions** (`engine/contract/constants.ts`):
  - New state `'blocked'` in `STATES`.
  - `TRANSITIONS` additions: `verifying → claimed` (send-back, verifier
    role), `verifying → blocked` (ceiling reached, verifier role),
    `blocked → claimed` (**human-operator only** — re-arming the fix budget
    is a human act).
  - Role gates enforced by `canTransition` as today; tests for each.
- **New tables (base DDL):**
  - `bureau_worktrees`: `id`, `task_id` (UNIQUE, FK — one worktree per task),
    `path`, `base_commit`, `status ('ready'|'dirty'|'stale'|'removed')`,
    `created_at`, `updated_at`, attribution of the creating actor.
  - `bureau_verify_runs`: `id`, `task_id` FK, `exit_code` (NULL on
    timeout/signal), `signal`, `timed_out`, `duration_ms`,
    `verify_fixes_before`, `stdout_tail`, `stderr_tail` (bounded to 4 KiB,
    redacted), `started_at`, `finished_at`, attribution.
- **New job kinds frozen:** `worktree.prepare`, `verify.run`.
- **Budgets as data:** `bureau_meta` keys `verify:fixes:ceiling` (default 2)
  and `verify:timeout_ms` (default 120000).
- **The seam** (`engine/contract/types.ts`):
  `WorkspaceHandle { taskId, path, baseCommit }` and
  `WorkspaceProvider { prepare(db, taskId), checkpoint(db, taskId, note?),
  isClean(db, taskId) }`, plus a provider override hook following the
  `setOfficerClientOverride` pattern from Phase 1 (`setWorkspaceProvider`).
- **Shared pure functions in the contract:** `scrubEnv(env)` (strips keys
  matching secret patterns: `GOOGLE_*`, `ANTHROPIC_*`, `OPENAI_*`,
  `BUREAU_*`, `*_API_KEY` — denylist, so Windows child processes keep the
  vars they need), `redactOutput(text)` (same patterns against stored tails),
  `parseVerifyOutcome(exitCode, signal, timedOut)`.
- **Contract tests** (`test/unit/contract_w0.test.ts`, mirroring
  `contract_m1.test.ts`): transition gates, schema migration from a Phase 1
  database, scrub/redact/parse units.

## 3. Stream A — Worktrees & checkpoints (Junior A: `engine/worktrees/`)

Worktrees live under `/.bureau-worktrees/<taskId>/` (add the anchored
`/.bureau-worktrees/` entry to `.gitignore` — see the gitignore scar).

| # | Deliverable | Acceptance |
|---|---|---|
| A1 | Worktree manager: idempotent create per task (UNIQUE `task_id`); **reuse-if-clean, refuse-if-dirty, never force-delete a dirty tree**; if `main` has moved past `base_commit`, record `status='stale'` with the stale base kept | T19, T20; mutation: delete the refuse-dirty guard, watch T19 fail |
| A2 | Checkpoints: `git add -A && git commit` in the worktree before every send-back and verify run; message `bureau-checkpoint: <taskId> <note>` with the attribution tuple as a trailer; no-op when clean | T21 |
| A3 | `worktree.prepare` job kind: claims a queued task through the state machine (`queued → claimed`, foreman attribution, one transaction), prepares the worktree, enqueues `verify.run`; idempotent on re-run after crash | Job tests + crash-resume test |
| A4 | Safe prune helper: deletes only `status='ready'` clean trees; dirty and stale trees are never touched automatically | Unit tests |

## 4. Stream B — Verifier & the loop (Junior B: `engine/verify/`)

| # | Deliverable | Acceptance |
|---|---|---|
| B1 | Verifier core: spawn the task's `verify_cmd` in the workspace path with `scrubEnv`-ed environment; tree-kill on timeout (reuse t14's `killTree`); capture exit code, signal, duration, redacted output tails; **command sourced from `bureau_tasks` only** | T22, T23 |
| B2 | `verify.run` job kind: transition `claimed → verifying` (verifier attribution), run the verifier, record the `bureau_verify_runs` row and attributed journal spans; on exit 0 → `verifying → needs-review` (Phase 4 will own what happens there) | T24 |
| B3 | The send-back loop: on nonzero exit with fixes remaining, ONE transaction does `verify_fixes + 1` and `verifying → claimed`, then a checkpoint runs through the seam; on the ceiling (`verify_fixes ≥ ceiling`), `verifying → blocked` + `notifyOperator` + `guardrail` span | T25; mutation: delete the increment, watch T25 fail (T26) |
| B4 | Crash safety mid-verify: a killed runner never double-increments `verify_fixes` and the run row is written exactly once | T28 |

## 5. Milestone WX — integration (both)

Merge order: `W0 → A1–A4 → B1–B4 → WX`. Real git worktree + real verifier,
the fake provider retired for these tests.

**Exit tests** (`test/integration`, numbering continues from T18):

- **T19** — worktree create is idempotent per task; reuse-if-clean; a dirty
  tree is refused, never force-deleted (mutation recorded).
- **T20** — a moved main records `stale` with the original base preserved.
- **T21** — checkpoints commit WIP with attribution; clean trees are a no-op.
- **T22** — a secret present in the parent environment is absent from the
  verify child's environment (child dumps its env as the verify command).
- **T23** — an over-timeout command is tree-killed and recorded
  `timed_out=1`.
- **T24** — success path: `needs-review`, run row complete, spans attributed.
- **T25** — **the exit sentence**: fail → send-back (checkpointed, counter
  incremented) → fail → send-back → third failure → `blocked`,
  operator notified, `guardrail` span; then, after a scripted fix and
  operator re-arm (`blocked → claimed` by human-operator only), a passing
  verify reaches `needs-review`.
- **T26** — the loop-bound mutation: removing the `verify_fixes` increment
  makes T25 fail.
- **T27** — output hygiene: a secret printed by the verify command appears
  nowhere in `bureau_verify_runs` or the journal.
- **T28** — kill the runner mid-`verify.run` (real child, hard kill),
  restart: exactly one run row, no double increment, task state consistent.

Plus `npm run demo:phase2` mirroring `demo_phase1.ts`: temp database,
cleanup in `finally`, journal printed, no `fail` spans — the demo output is
the phase's recorded evidence.

## 6. Explicitly out of scope for Phase 2

The Junior harness (CDP, selectors, nonces — Phase 3), the Senior's review
gates, operator approval UI, PR creation and merge (Phase 4), watchdog,
backup push, the Secretary, dashboards, the red-team sweep beyond the two
rules already baked in (bureau-owned verify command, scrubbed env).
