# Phase 3 Stream B Mutation Evidence — Selector Registry & Calibration Gate

**Branch**: `wt/junior-b-selectors`  
**Engineer**: Junior B  
**Target Files**: `engine/selectors/gate.ts`, `engine/selectors/registry.ts`  
**Associated Tests**: `test/integration/t35_calibration_gate.test.ts`, `test/integration/t33_calibration_fail.test.ts`

---

## Mutation 1: Calibration Gate Check Removal (`t35_calibration_gate.test.ts`)

### Guard Under Test
`GatedIdeDriver.checkGate()` in `engine/selectors/gate.ts` checks `bureau_selectors.status` and throws `UncalibratedSelectorError` (journaling a `guardrail` span) BEFORE delegating `read` or `act` calls to the underlying driver.

### Code Mutation Applied
Commented out `this.checkGate(...)` calls in `GatedIdeDriver.read` and `GatedIdeDriver.act`:

```diff
  async read(selectorKey: string): Promise<IdeDriverReadResult> {
-   this.checkGate(selectorKey, 'read');
+   // MUTATED: this.checkGate(selectorKey, 'read');
    return await this.innerDriver.read(selectorKey);
  }

  async act(selectorKey: string, action: IdeDriverAction, value?: string): Promise<IdeDriverActResult> {
-   this.checkGate(selectorKey, action);
+   // MUTATED: this.checkGate(selectorKey, action);
    return await this.innerDriver.act(selectorKey, action, value);
  }
```

### Verification Command & Output
```bash
npx vitest run test/integration/t35_calibration_gate.test.ts
```

**Result**: FAIL as expected.

```text
 ❯ test/integration/t35_calibration_gate.test.ts (1 test | 1 failed) 137ms
   × T35: Calibration Gate Integration Test > refuses actions on uncalibrated selectors, browser never sees them, and journals guardrail span 136ms
     → promise resolved "{ success: true, …(1) }" instead of rejecting

FAIL  test/integration/t35_calibration_gate.test.ts > T35: Calibration Gate Integration Test > refuses actions on uncalibrated selectors, browser never sees them, and journals guardrail span
AssertionError: promise resolved "{ success: true, …(1) }" instead of rejecting
```

---

## Mutation 2: Calibration Match Count Equality Check Removal (`t33_calibration_fail.test.ts`)

### Guard Under Test
`selectorCalibrateHandler()` in `engine/selectors/registry.ts` requires `readRes.matchCount === 1` on every read iteration to transition selector status to `calibrated`. If `matchCount !== 1`, it breaks and sets status to `failed`.

### Code Mutation Applied
Modified the condition in `selectorCalibrateHandler()` to ignore match count check:

```diff
-   if (readRes.matchCount !== 1) {
+   if (false /* MUTATED */) {
      consistentOneMatch = false;
      break;
    }
```

### Verification Command & Output
```bash
npx vitest run test/integration/t33_calibration_fail.test.ts
```

**Result**: FAIL as expected.

```text
 ❯ test/integration/t33_calibration_fail.test.ts (1 test | 1 failed)
   × T33: Selector Calibration Fail Integration Test > fails calibration for an ambiguous selector and records evidence in job last_error and journal
     → expected selector status 'calibrated' to be 'failed'
```

---

## Conclusion
Both mutations broke the targeted guards and were immediately caught by the respective integration tests `T35` and `T33`. Code was restored and full suite verified green (145/145 tests passing).
