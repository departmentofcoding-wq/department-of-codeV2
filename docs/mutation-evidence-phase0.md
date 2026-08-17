# Phase 0 Mutation Evidence

The standing rule: a test that still passes after deleting the behavior it
claims to protect is not a finished test. Every guard in Phase 0 has been
broken on purpose, and a named test failed. This file is the record.

## Re-verified 2026-08-17 (post-review fixes, run by the Senior)

### 1. Journal work-session backfill (the one door)

- **Guard**: `journal()` in `engine/journal/writer.ts` backfills `work_uuid`
  and `work_title` from `bureau_tasks` for any span that names a task. All job
  lifecycle spans route through this door, so a task's whole life is one
  query on `work_uuid`.
- **Mutation**: disabled the backfill condition (`if (false && span.taskId ...)`).
- **Failing tests** (3):
  - `engine/journal/journal.test.ts > backfills work_uuid and work_title from bureau_tasks when omitted` — `AssertionError: expected null to be 'work-uuid-999'`
  - `test/unit/jobs.test.ts > job spans backfill work_uuid and work_title through the one journal door` (Fake DB leg) — `AssertionError: expected null to be 'work-j1'`
  - same test, Real node:sqlite leg — `AssertionError: expected null to be 'work-j1'`

### 2. Dead jobs carry no scheduled retry

- **Guard**: `failJob()` in `engine/jobs/jobs.ts` sets `run_after = NULL` on
  the terminal (dead) update. A dead job with a stale `run_after` would be a
  row lying about a retry that will never happen.
- **Mutation**: removed the `run_after = NULL` from the dead UPDATE.
- **Failing tests** (2):
  - `test/unit/jobs.test.ts > failJob increments attempts, truncates error, and backs off until max attempts` (Fake DB leg) — `AssertionError: expected '2026-08-17T04:11:33.820Z' to be null`
  - same test, Real node:sqlite leg — `AssertionError: expected '2026-08-17T04:11:34.165Z' to be null`

## Recorded by the Juniors during Phase 0 (from their walkthroughs)

### 3. Done-gate CHECK constraint (Junior A)

- **Mutation**: removed `CHECK (state <> 'done' OR (verifier_exit_code IS NOT NULL AND verifier_exit_code = 0 AND approved_at IS NOT NULL AND approved_by IS NOT NULL))` from `bureau_tasks`.
- **Failing test**: `engine/state/state.test.ts > T1: done-gate` — raw SQL update to `done` succeeded without the CHECK firing.

### 4. Human-operator approval gate (Junior A)

- **Mutation**: removed the `actorRole !== 'human-operator'` check in `canTransition()` / `approveTask()`.
- **Failing test**: `engine/state/state.test.ts > canTransition ... enforces human-operator for done` — senior-engineer allowed to transition to `done`.

### 5. Append-only triggers (Junior A)

- **Mutation**: dropped `bureau_journal_no_update` / `bureau_journal_no_delete`.
- **Failing test**: `engine/journal/journal.test.ts > T2: UPDATE and DELETE on bureau_journal raise errors`.

### 6. Attribution validation (Junior A)

- **Mutation**: removed the `!model` check in `journal()`.
- **Failing test**: `engine/journal/journal.test.ts > journal throws if attribution or model is missing`.

### 7. Idempotent child enqueue (Junior B)

- **Mutation**: `enqueueJobIfAbsent` used plain `INSERT` instead of `INSERT OR IGNORE`.
- **Failing test**: `test/integration/t4_crash_resume.test.ts` — SQLite primary-key constraint violation on duplicate child id during crash-resume re-enqueue.
