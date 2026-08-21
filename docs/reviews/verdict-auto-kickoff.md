# Senior Verdict — Auto-kickoff Flow + Console Runner

**Commit under review:** `592dc091d0db3ebb33b159a9dcd8c82cf36c0e51`
**Branch:** `wt/junior-auto-kickoff-flow` (cut from `main` at `dd341a9`, single commit)
**Scope:** Auto-kickoff of the plan flow at the filing door, a bounded self-healing
reconciler, a background Runner owned by the console, and `claimJob` kind
exclusion so the Runner never races the console's inline intake drain.
**Date:** 2026-08-21
**Verdict:** ✅ **APPROVE — merge to main** (one process defect remedied below)

## What was verified (independently, not trusted)

- **Suite + build, re-run by the senior:** two full runs, both exit 0 —
  **314/314 across 77 files** (main was 300/76; +14: filing 5×2-impl tests
  net-new kickoff cases, reconciler 4×2, claimJob exclude +2… actual counts per
  files) — and `tsc --noEmit` clean. Matches the walkthrough claim.
- **Filing-door kickoff**: `enqueueJobIfAbsent` with deterministic
  `plan.cycle:<taskId>` runs INSIDE the filing `execTransaction`, after the
  task-filed journal span — there is no window where a task exists without its
  cycle. Payload `{ taskId }` satisfies the `plan.cycle` schema (junior/senior
  optional, defaulted by assignment policy); `max_attempts: 1` matches the job
  definition. The door only enqueues — draining stays a separate door, so the
  human-approval + verifier-exit-0 gate on `done` is untouched.
- **Reconciler is bounded and composes**: the `NOT EXISTS` guard counts ANY
  `plan.cycle` row for the task — including `dead`/failed — so a terminally
  failed cycle is never retried in a loop; only `queued` tasks are swept; the
  shared deterministic id + `INSERT OR IGNORE` makes filing∘reconcile
  double-enqueue impossible. Verified on both the fake DB and real
  `node:sqlite` test implementations.
- **claimJob exclusion**: parameterized `kind NOT IN (...)` with correct
  placeholder ordering (SET ×3, `run_after` ×1, then the exclusion slots —
  params array matches exactly). The exclude test is honest: the excluded
  `intake.turn` is older than the `plan.cycle`, so FIFO claiming would take it;
  the test proves the runner steps over it and leaves it pending for its
  inline owner.
- **Console Runner lifecycle**: started only under `opts.serve` (unit tests
  never start loops), constructed with `excludeKinds: ['intake.turn']`;
  shutdown is idempotent and ordered `runner.stop()` → `handle.close()` →
  `closeDatabase()`. Standalone `npm run runner` added, consistent with the
  existing script style.
- **Live-DB verification (read-only)**: the "Department Assets" task
  (`82b97764-ad52-4a50-ab19-21ecbc8bfcd3`) is `queued` with **zero**
  `plan.cycle` jobs — exactly the stranded condition this stream fixes; the
  reconciler will sweep it in on the next Runner start.

## Mutation evidence — Junior omitted it; Senior executed and recorded

The commit ships guard tests but **no recorded mutation evidence** (a bureau-law
requirement). Remedied: the Senior executed the representatives and recorded
them in `docs/mutation-evidence-phase7.md` (M-AK1/M-AK2/M-AK3):

- **M-AK1 (deterministic id)**: time-suffixing `planCycleJobId` fails 4 tests
  across both DB impls (filing "keyed on the task id" ×2, reconciler "enqueues
  exactly one" ×2) — the one-task→one-cycle guarantee has a single point of
  failure and it is guarded. Restored, green.
- **M-AK2 (kind exclusion)**: removing the `claimJob` kind filter fails the
  exclude test on both impls (the runner claims the intake job — the exact
  race the guard prevents). Restored, green.
- **M-AK3 (reconciler `NOT EXISTS`, honest finding)**: adding `state != 'dead'`
  to the guard's subquery is **NOT caught** — and correctly so: the
  deterministic-id `INSERT OR IGNORE` redundantly blocks re-enqueue of a dead
  cycle regardless. Defense-in-depth, not a test gap; recorded so the next
  reader knows the guarantee survives either mechanism failing.

## Non-blocking notes (operator advisories)

- **The stranded task will start moving.** On the next console (or standalone
  runner) start, the reconciler enqueues a real `plan.cycle` for "Department
  Assets" — junior authors a plan via the live Antigravity harness, senior
  reviews, and on approve the flow continues toward worktree/dispatch/PR on the
  department's own repo. Phase 7's safety posture wants live runs supervised
  and against a sandbox remote; the operator should decide to either watch it
  run or park the task first. This is an operational decision, not a code
  defect.
- If a standalone `npm run runner` runs alongside the console, it claims
  `intake.turn` too and can race the console's inline drain (the intake POST
  would 500 while the standalone runner actually executes the turn; the panel
  recovers via GET). Single-console operation — the documented setup — is
  unaffected.
- A terminally failed cycle leaves the task for the operator by design
  (maxAttempts 1); re-running is an explicit action.

The two original gaps (filing enqueued no work; console started no runner) are
both closed, each idempotently and without touching the done-gate. Approved.
