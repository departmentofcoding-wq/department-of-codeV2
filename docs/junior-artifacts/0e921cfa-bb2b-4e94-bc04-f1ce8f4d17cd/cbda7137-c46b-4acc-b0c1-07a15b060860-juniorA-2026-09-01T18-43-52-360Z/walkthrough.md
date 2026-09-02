Walkthrough — N11: Serialize Same-Junior Plan Authoring on Per-Junior Window Lease
Summary of Changes
1. Flow Engine (
plan_review_cycle.ts
)
Per-Junior Window Lease: Computed windowTarget = window-${juniorId}`` and integrated the existing lease management infrastructure (acquireLease, releaseLease, startWindowLeaseHeartbeat from
lease-manager.ts
).
Tracking Dispatch Record: Created a tracking record in bureau_dispatches with status 'lease_wait' prior to lease acquisition to satisfy SQLite foreign-key constraints while avoiding false watchdog flags (sweep.ts only flags 'pending'/'running' dispatches).
In-Process Polling Wait Loop: Implemented a non-terminal polling wait loop catching
LeaseError
with configurable leasePollMs and leaseTimeoutMs, respecting opts.signal. This ensures contending tasks for the same junior serialize without violating plan.cycle's maxAttempts: 1 single-attempt policy.
Heartbeat & Guaranteed Release: Started window lease heartbeat upon acquisition, recorded window_lease_heartbeat_started and window_lease_heartbeat_stopped journal spans, and released the lease in a finally block on both success and thrown errors.
2. Integration Tests (
tc_plan_cycle.test.ts
)
Added comprehensive test coverage:
Same-Junior Serialization: Verified two concurrent plan authoring cycles on the same junior serialize (the second task waits in the polling loop and acquires only after the first releases).
Different-Junior Concurrency: Verified tasks assigned to different juniors (window-A vs window-B) acquire and execute in parallel with overlapping execution.
Heartbeat Renewal: Verified the lease is actively renewed by heartbeat during authoring and window_lease_heartbeat_started/_stopped journal entries are recorded.
Guaranteed Cleanup on Error: Verified driver crashes during authoring trigger clean lease release, allowing subsequent tasks to acquire without conflict.
Verification Results
TypeScript Type Check:
powershell
npx tsc --noEmit
# Exit code: 0 (clean)
Integration Test Suite:
powershell
npx vitest run test/integration/tc_plan_cycle.test.ts
# ✓ test/integration/tc_plan_cycle.test.ts (14 tests) passed
Walkthrough
Walkthrough of changes for N11: serialize same-junior plan authoring on the per-junior window lease.
2 files changed
+285
-17
Review
Review Changes
