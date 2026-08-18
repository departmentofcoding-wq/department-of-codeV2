# Peer Review Checklist: Milestone C0 Contract Freeze (`wt/junior-a-c0`)

**Reviewer**: Junior B (Selector Registry & Nonces Stream)  
**Target PR**: Milestone C0 (`wt/junior-a-c0` -> `main`)  
**Status**: APPROVED & VERIFIED  

---

## Verification Checklist

| # | Item | Requirement | Status | Verification Evidence / Code Reference |
| :-: | :--- | :--- | :---: | :--- |
| **1** | **Seam Neutrality** | `IdeDriver` interface and override hooks live in frozen contract; throws if unset | ✅ **PASS** | [`engine/contract/ide-driver-seam.ts`](file:///d:/Dept%20of%20code%20v2/engine/contract/ide-driver-seam.ts) and [`engine/contract/types.ts`](file:///d:/Dept%20of%20code%20v2/engine/contract/types.ts). |
| **2** | **Base DDL & Migrations** | DDL for `bureau_selectors`, `bureau_window_leases`, `bureau_observations`, and `bureau_dispatches.attempts` ADDED_COLUMNS | ✅ **PASS** | Defined in [`engine/db/schema.ts`](file:///d:/Dept%20of%20code%20v2/engine/db/schema.ts); tested in [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts). |
| **3** | **Lease Exclusivity Index** | Partial UNIQUE index `idx_window_leases_active` on `(window_target) WHERE status = 'active'` | ✅ **PASS** | Base DDL and `applyBootMigrations` in [`engine/db/schema.ts`](file:///d:/Dept%20of%20code%20v2/engine/db/schema.ts); tested in [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts). |
| **4** | **Exact JSON Correlation** | `isCorrelated` parses JSON detail, requires strict `===` nonce match, rejects near-misses and substring matches | ✅ **PASS** | [`engine/contract/harness-pure.ts`](file:///d:/Dept%20of%20code%20v2/engine/contract/harness-pure.ts); unit tested in [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts). |
| **5** | **Pure Function Math** | `mintNonce` (32 hex chars), `leaseIsExpired` (boundary math with ISO string / epoch ms / Date) | ✅ **PASS** | [`engine/contract/harness-pure.ts`](file:///d:/Dept%20of%20code%20v2/engine/contract/harness-pure.ts); unit tested in [`test/unit/contract_c0.test.ts`](file:///d:/Dept%20of%20code%20v2/test/unit/contract_c0.test.ts). |
| **6** | **Constants & Enums** | Frozen job kinds (`junior.dispatch`, `selector.calibrate`, `lease.reap`), span kinds (`dispatch`, `observation`), `HARNESS_META_KEYS`, `DEFAULT_LEASE_MS` | ✅ **PASS** | [`engine/contract/constants.ts`](file:///d:/Dept%20of%20code%20v2/engine/contract/constants.ts). |

---

## Conclusion
Milestone C0 fulfills all contract requirements for Phase 3. Both Stream A and Stream B can safely branch from C0 to begin CDP client (Stream A) and Selector Registry / Nonce Correlation (Stream B) development.
