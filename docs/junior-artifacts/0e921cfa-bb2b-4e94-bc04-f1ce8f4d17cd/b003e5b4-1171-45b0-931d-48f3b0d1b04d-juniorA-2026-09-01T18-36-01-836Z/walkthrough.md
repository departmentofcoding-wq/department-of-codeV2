Walkthrough: Serialize Same-Junior Plan Authoring on Per-Junior Window Lease
1. Summary of Changes
Flow Engine (
engine/flow/plan_review_cycle.ts
):
Window Lease Acquisition: Integrated acquireLease, releaseLease, and startWindowLeaseHeartbeat from engine/harness/lease-manager.ts into the junior plan-authoring step (runPlanReviewCycle) targeting window-${juniorId}.
FK Tracking Dispatch & Watchdog Hygiene: Inserted a tracking dispatch row into bureau_dispatches initialized with status 'lease_wait' during polling so engine/watchdog/sweep.ts does not emit false positive dispatch_no_live_lease findings while waiting. Upon lease acquisition, status transitions to 'running', and completes with 'completed' / 'failed'.
In-Process Polling Loop: Wrapped acquireLease in an in-process polling loop (with configurable leasePollMs and leaseTimeoutMs) catching LeaseError so concurrent plan authorings for the same junior serialize cleanly on one window without failing or burning the job's single-attempt budget (maxAttempts: 1).
Heartbeat & Guaranteed Release: Heartbeat runs throughout the authoring session with attributed journal spans (window_lease_heartbeat_started / window_lease_heartbeat_stopped), and the lease is strictly released in the finally block on both success and failure paths.
Test Suite (
test/integration/tc_plan_cycle.test.ts
):
Added test for Concurrent Same-Junior Serialization: Proves Task 2 yields and waits during Task 1's authoring run, then acquires window-A and authors only after Task 1 releases.
Added test for Concurrent Cross-Junior Parallelism: Proves tasks assigned to different juniors (window-A vs window-B) acquire and author concurrently without blocking.
Added test for Heartbeat Renewal: Validates that long authoring runs maintain an active lease with incrementing heartbeats, prevents lease reaping, and emits proper journal spans.
Added test for Guaranteed Release on Error: Simulates a driver exception and verifies the lease transitions to released, immediately unblocking waiting same-junior tasks.
2. Verification Results
TypeScript Compilation (npx tsc --noEmit / npm run build):
> department-of-code-v2@2.0.0 build
> tsc --noEmit
Exit code: 0
Targeted Integration Suites:
npx vitest run test/integration/tc_plan_cycle.test.ts: 15/15 passed
npx vitest run test/integration/tc_dispatch_window_heartbeat.test.ts: 4/4 passed
Full Suite (npm test):
Test Files  123 passed (123)
Tests  680 passed (680)
Duration  64.18s
Exit code: 0
2 files changed
+350
-20
Review
11:58 PM, 9/1/2026
2 Files With Changes
Reject all
Accept all
+147
-4
plan_review_cycle.ts
d:\Dept of code v2\.bureau-worktrees\0e921cfa-bb2b-4e94-bc04-f1ce8f4d17cd\engine\flow\plan_review_cycle.ts
+194
-7
tc_plan_cycle.test.ts
d:\Dept of code v2\.bureau-worktrees\0e921cfa-bb2b-4e94-bc04-f1ce8f4d17cd\test\integration\tc_plan_cycle.test.ts
