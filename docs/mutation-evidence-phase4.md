# Department of Code v2 — Phase 4 Mutation Evidence

Record of guards broken and test failures observed during Phase 4 implementation. Every pull request must append real mutation evidence demonstrating that its tests actually catch regressions in its guards.

---

## Milestone D0 — Contract Freeze

### Guard Mutation: `bureau_work_reviews.reviewed_commit` Schema Boot Migration Entry
- **Target Guard**: `{ table: 'bureau_work_reviews', name: 'reviewed_commit', definition: 'TEXT' }` in `ADDED_COLUMNS` (`engine/db/schema.ts:278`).
- **Mutation Applied**: Removed `{ table: 'bureau_work_reviews', name: 'reviewed_commit', definition: 'TEXT' }` entry from `ADDED_COLUMNS`.
- **Catching Test**: `test/unit/contract_d0.test.ts` > `Milestone D0 — Contract Freeze > 1. Schema Migration (bureau_work_reviews.reviewed_commit) > migrates a Phase 3 database by adding reviewed_commit column and preserving legacy rows`.
- **Execution Result**:

```
 ❯ test/unit/contract_d0.test.ts (9 tests | 1 failed) 344ms
   × Milestone D0 — Contract Freeze > 1. Schema Migration (bureau_work_reviews.reviewed_commit) > migrates a Phase 3 database by adding reviewed_commit column and preserving legacy rows 266ms
     → expected false to be true // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/unit/contract_d0.test.ts > Milestone D0 — Contract Freeze > 1. Schema Migration (bureau_work_reviews.reviewed_commit) > migrates a Phase 3 database by adding reviewed_commit column and preserving legacy rows
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ test/unit/contract_d0.test.ts:111:70
    109|       // Assert reviewed_commit column now exists
    110|       const migratedCols = db.prepare('PRAGMA table_info(bureau_work_reviews)').all();
    111|       expect(migratedCols.some((c) => c.name === 'reviewed_commit')).toBe(true);
```

- **Restoration**: Restored `{ table: 'bureau_work_reviews', name: 'reviewed_commit', definition: 'TEXT' }` to `ADDED_COLUMNS` in `engine/db/schema.ts`. Test passed cleanly (9/9 passed).
