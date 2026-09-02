# Implementation Plan: Window-Lease Heartbeat for Long GUI Dispatches (Phase 8 P1.2)

## 1. Verified Execution Context
- **Repository**: `Department of Code (D:\Dept of code v2)`
- **Primary Checkout Directory**: `D:\Dept of code v2`
- **Active Branch**: `main` (verified at commit `7163e72`, clean of related window-lease changes).
- **Execution Policy**: Engine development for Department of Code core harness primitives (`engine/harness/lease-manager.ts`, `engine/harness/dispatch-job.ts`) is conducted directly in the primary checkout on `main`. No branch switching or creation.

---

## 2. Design Rationale: Why Both Heartbeat AND Per-Junior Scoping

The task specification offers a choice between renewing window leases via heartbeat OR scoping leases per junior. We explicitly implement **both**, as neither alone satisfies the operational requirements:

1. **Acceptance Criteria Mandate Heartbeats**: The acceptance criteria require that a long dispatch retain its lease with `heartbeats > 0` and not be reaped. Per-junior scoping alone leaves `heartbeats: 0`, meaning any single dispatch running longer than the 2-minute `DEFAULT_LEASE_MS` is reaped. Thus, heartbeating is strictly necessary.
2. **Preventing Artificial Serialization Across Juniors**: If we only added heartbeating to the shared `window-default` key, junior A and junior B (which run separate GUI windows/ports) would contend for the same lease. Instead of junior B getting the window after a 2-minute reap, junior B would be blocked for the entire duration of junior A's dispatch (up to 30 minutes), serializing independent juniors.
3. **Window Target Precedence**: Explicit `payload.windowTarget` always takes precedence. In its absence, the target defaults to `window-${payload.junior}` (e.g., `window-A`, `window-B`), falling back to `window-default` if neither is provided.
4. **Stale Rows in Live DBs**: Any existing active `window-default` rows in live databases will expire naturally and be cleaned up by the existing `reapExpiredWindowLeases` runner sweep without requiring database schema migrations.

---

## 3. Enumerable Scope (Components & Files)

### Component 1: Lease Manager (`engine/harness/lease-manager.ts`)
- Add `startWindowLeaseHeartbeat(db, leaseId, options)` helper:
  - **Interval Derivation & Floor**: `intervalMs = Math.max(1000, Math.floor(getLeaseMs(db, options.leaseMs) / 3))`. Against default 120s lease, interval is 40s; against a test lease of 3000ms, interval is 1000ms. Test leases are kept >= 3000ms so the 1000ms floor maintains a safe 3x renewal margin.
  - **Injected Clock Seam**: Supports optional clock injection (`nowMs?: () => number` or deterministic tick runner) for zero-flakiness testing.
  - **Sync Exception Protection**: Interval callback executes inside a `try { ... } catch (err)` block so sync errors never propagate as uncaught exceptions in the runner process.
  - **Fail-Closed Error Hook**: Invokes `onError(err)` callback when `heartbeatLease` throws (e.g. lease reaped, expired, or ceiling hit).
  - Returns a handle `{ stop: () => number }` that clears the interval and returns the final heartbeat count.

### Component 2: Dispatch Job (`engine/harness/dispatch-job.ts`)
- **Window Target Resolution**:
  ```ts
  const windowTarget = payload.windowTarget || (payload.junior ? `window-${payload.junior}` : 'window-default');
  ```
- **Heartbeat Lifecycle & Composed Abort Signal**:
  1. `acquireLease(ctx.db, windowTarget, dispatch.id, attribution)` is called.
  2. Create an internal `internalAbortController = new AbortController()`.
  3. Compose abort signals:
     ```ts
     const combinedSignal = ctx.signal
       ? AbortSignal.any([ctx.signal, internalAbortController.signal])
       : internalAbortController.signal;
     ```
     Pass `combinedSignal` to the driver `runCommand` call, and check `combinedSignal.aborted` in the LLM-decision loop.
  4. Start heartbeat via `startWindowLeaseHeartbeat`:
     - Journal system span: `window_lease_heartbeat_started` (`{ leaseId, windowTarget, dispatchId, intervalMs }`).
     - On heartbeat error (`onError`): Journal guardrail span `window_lease_heartbeat_failed` (`{ leaseId, windowTarget, dispatchId, error: err.message }`) and call `internalAbortController.abort(err)`. This rejects the in-flight driver promise, jumping into the dispatch `catch` block where `detail: { status: 'failed', ... }` is journaled.
  5. In `finally` block:
     - **Strict Ordering**: Call `heartbeatHandle.stop()` (clearing the timer) **BEFORE** `releaseLease(ctx.db, lease.id)`.
     - Journal system span: `window_lease_heartbeat_stopped` (`{ leaseId, windowTarget, dispatchId, heartbeats }`).
     - Call `releaseLease(ctx.db, lease.id)`.
  6. Abort and timeout safety: `ctx.signal` aborts or timeouts trigger the standard `finally` block, ensuring timers and leases are reliably cleaned up.

---

## 4. Tracked Acts (Journal Spans)

To maintain department merge discipline and visibility:
- **Heartbeat Started** (`system` kind):
  - `action: 'window_lease_heartbeat_started'`, `leaseId`, `windowTarget`, `dispatchId`, `intervalMs`.
- **Heartbeat Stopped** (`system` kind):
  - `action: 'window_lease_heartbeat_stopped'`, `leaseId`, `windowTarget`, `dispatchId`, `totalHeartbeats`.
- **Heartbeat Failure** (`guardrail` kind):
  - `reason: 'window_lease_heartbeat_failed'`, `leaseId`, `windowTarget`, `dispatchId`, `error`.
*(Note: Individual routine heartbeat ticks are NOT journaled to avoid span noise).*

---

## 5. Test Suite & Mutation Evidence

### Proposed Tests

1. **Manager-Level Unit Tests** (`test/unit/lease_manager_heartbeat.test.ts`):
   - **T1: Heartbeat loop execution**: Injected clock advances; `heartbeatLease` is called; `heartbeats` increment; `stop()` clears timer cleanly.
   - **T2: Heartbeat failure handling**: When lease status changes to `reaped` or `released`, the heartbeat loop catches the `LeaseError`, invokes `onError`, and prevents unhandled runner crashes.
   - **T3: Ceiling enforcement**: When `bureau_meta['harness:lease:heartbeats']` ceiling is exceeded, heartbeat throws and triggers error handler.

2. **Integration Tests** (`test/integration/tc_dispatch_window_heartbeat.test.ts`):
   - **T4: Long dispatch renewal**:
     - Set `bureau_meta['harness:lease_ms'] = 3000` (heartbeat interval = 1000ms).
     - Dispatch runs a simulated async driver command for 5000ms using `vi.advanceTimersByTimeAsync`.
     - Assert lease row in DB: `status = 'active'`, `heartbeats >= 2`.
     - Invoke `reapExpiredWindowLeases(db, now)` with `now` 4000ms past start. Assert lease is NOT reaped.
   - **T5: Per-junior concurrency & exclusivity**:
     - Concurrently run dispatch for `junior: 'A'` and dispatch for `junior: 'B'`. Both acquire distinct leases (`window-A` and `window-B`) and complete without conflict.
     - A second dispatch attempting `junior: 'A'` while first is running fails with `LeaseError`.
     - Advance fake time past lease duration; second dispatch attempting `window-A` STILL fails with `LeaseError` because active heartbeat holds the lease.
   - **T6: Fail-closed hard process crash simulation**:
     - Simulated at component level: acquire lease and start heartbeat loop, then intentionally abandon both (no `stop()`, no `releaseLease()`).
     - Advance clock past lease expiry.
     - `reapExpiredWindowLeases` reaps the expired lease, journals `lease_expired_reaped`.
     - Subsequent dispatch / acquire for that window target succeeds cleanly.
   - **T7: Fail-closed lease loss during dispatch**:
     - While dispatch is running, manually reap/release its lease in the DB.
     - Next heartbeat tick catches `LeaseError`, journals `window_lease_heartbeat_failed`, and aborts the dispatch.
     - Assert dispatch row reaches `status = 'failed'` and `finally` runs to clean up resources.

### Mutation Evidence

| Mutation | Test That Catches It | Expected Failure |
| :--- | :--- | :--- |
| **M1**: Omit heartbeat loop from `dispatch-job.ts` | **T4** (Long dispatch renewal) | Lease reaped after 3s; `heartbeats === 0` |
| **M2**: Default to shared `window-default` instead of `window-${junior}` | **T5** (Per-junior concurrency) | Second junior throws `LeaseError` on `window-default` conflict |
| **M3**: Omit `try/catch` in interval callback | **T2** / **T7** (Heartbeat failure) | Uncaught exception in timer; test runner crash |
| **M4**: "Log and continue" on heartbeat failure instead of aborting | **T7** (Fail-closed lease loss) | Dispatch keeps executing despite lost lease; `status` does not transition to `failed` |
| **M5**: Release lease before clearing heartbeat interval | **T1** / **T4** (Ordering) | Late heartbeat tick fires against released lease |

---

## 6. Walkthrough & Verification Plan

1. **Type Checking & Linting**:
   - `npx tsc --noEmit`
2. **Targeted Test Runs**:
   - `npx vitest run test/unit/lease_manager_heartbeat.test.ts`
   - `npx vitest run test/integration/tc_dispatch_window_heartbeat.test.ts`
   - `npx vitest run test/integration/t31_window_lease.test.ts test/integration/tc_dispatch_antigravity.test.ts`
3. **Full Suite Verification**:
   - Run full vitest test suite twice: `npx vitest run` x2 (must be 100% green).
   - Build verification: `npm run build`.
