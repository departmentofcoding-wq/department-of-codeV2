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

---

## Stream A — Senior Review Gates & Formalized Junior Prompt

### M-A1: Plan Rubric Refusal Gate
- **Target Guard**: `if (!rubric.ok)` check before model call in `handleSeniorReviewPlan` (`engine/review/plan_review_job.ts`).
- **Mutation Applied**: Commented out the `if (!rubric.ok)` block so failing plans bypass deterministic refusal and call the model directly.
- **Catching Test**: `test/integration/t39_t40_plan_review.test.ts` > `T39: Plan review — rubric refusal before model, passing plan model verdict, transactional plan_rounds increment, & dispatch enqueue on approval`.
- **Execution Result**:
```
 ❯ test/integration/t39_t40_plan_review.test.ts (4 tests | 1 failed)
   × T39: Plan review — rubric refusal before model
     AssertionError: expected mockClient.callHistory.length (1) to be 0
```
- **Restoration**: Restored `if (!rubric.ok)` check. Test passed cleanly.

### M-A2: Ceiling Entry-Guard
- **Target Guard**: `if (task.state === 'blocked' || task.plan_rounds >= ceiling)` check at job entry in `handleSeniorReviewPlan` (`engine/review/plan_review_job.ts`).
- **Mutation Applied**: Removed the entry-guard check at the top of `handleSeniorReviewPlan`.
- **Catching Test**: `test/integration/t39_t40_plan_review.test.ts` > `T40: Plan rounds exhaustion — entry-guard blocks task at ceiling (3), notifies operator, and refuses subsequent review jobs`.
- **Execution Result**:
```
 ❯ test/integration/t39_t40_plan_review.test.ts (4 tests | 1 failed)
   × T40: Plan rounds exhaustion
     AssertionError: expected task plan_rounds (4) to be 3
```
- **Restoration**: Restored top-level ceiling entry-guard. Test passed cleanly.

### M-A3: Work Review Preconditions Gate (Fail-Closed)
- **Target Guard**: `if (task.verifier_exit_code !== 0)` check in `evaluateWorkPreconditions` (`engine/review/work_review_job.ts`).
- **Mutation Applied**: Removed `verifier_exit_code !== 0` check from `evaluateWorkPreconditions`.
- **Catching Test**: `test/integration/t41_work_review.test.ts` > `T41: Work review gate — refuses on precondition failure without model call; passing preconditions record tip commit hash`.
- **Execution Result**:
```
 ❯ test/integration/t41_work_review.test.ts (2 tests | 1 failed)
   × T41: Work review gate — refuses on precondition failure
     AssertionError: expected mockClient.callHistory.length (1) to be 0
```
- **Restoration**: Restored `verifier_exit_code !== 0` precondition check. Test passed cleanly.

### M-A4: Branch Tip Commit Recording
- **Target Guard**: `const tipCommit = await getBranchTipCommit(ctx.db, task.id)` in `handleSeniorReviewWork` (`engine/review/work_review_job.ts`).
- **Mutation Applied**: Replaced `tipCommit` with `worktree.base_commit`.
- **Catching Test**: `test/integration/t41_work_review.test.ts` > `T41: Work review gate — refuses on precondition failure without model call; passing preconditions record tip commit hash`.
- **Execution Result**:
```
 ❯ test/integration/t41_work_review.test.ts (2 tests | 1 failed)
   × T41: Work review gate
     AssertionError: expected reviewed_commit ('3a1f9...') to equal newTipCommit ('8b9c2...')
```
- **Restoration**: Restored `getBranchTipCommit` tip commit resolution. Test passed cleanly.
## Stream B — Operator Approval Door & Delivery (PR + Merge)

### M-B1: Verifier Exit Code Approval Gate
- **Target Guard**: `if (task.verifier_exit_code !== 0)` check in `approveTask` (`engine/state/machine.ts:100`).
- **Mutation Applied**: Commented out the non-zero verifier exit code check in `approveTask`.
- **Catching Test**: `test/integration/t42_approval_door.test.ts` > `T42: Approval Door CLI & approveTask Integration Test > refuses approval when verifier exit code is non-zero`.
- **Execution Result**:

```
 ❯ test/integration/t42_approval_door.test.ts (4 tests | 1 failed) 350ms
   × T42: Approval Door CLI & approveTask Integration Test > refuses approval when verifier exit code is non-zero
     → expected [Function] to throw error matching /cannot be approved because verifier exit code is 1/

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/integration/t42_approval_door.test.ts > T42: Approval Door CLI & approveTask Integration Test > refuses approval when verifier exit code is non-zero
AssertionError: expected [Function] to throw error matching /cannot be approved because verifier exit code is 1/
```

- **Restoration**: Restored `verifier_exit_code !== 0` check in `machine.ts`. Test passed (4/4 passed).

---

### M-B2: PR Creation Commit Hash Match Gate
- **Target Guard**: `if (!latestReview.reviewed_commit || latestReview.reviewed_commit !== currentTip)` check in `handlePrCreate` (`engine/delivery/pr_create.ts:46`).
- **Mutation Applied**: Bypassed commit hash comparison check in `handlePrCreate`.
- **Catching Test**: `test/integration/t43_pr_create.test.ts` > `T43: pr.create Job Integration Test > refuses when work review commit does not match branch tip`.
- **Execution Result**:

```
 ❯ test/integration/t43_pr_create.test.ts (3 tests | 1 failed) 1200ms
   × T43: pr.create Job Integration Test > refuses when work review commit does not match branch tip
     → expected [Function] to throw error matching /work review commit (outdated-hash-999) does not match current branch tip/

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/integration/t43_pr_create.test.ts > T43: pr.create Job Integration Test > refuses when work review commit does not match branch tip
AssertionError: expected [Function] to throw error matching /work review commit (outdated-hash-999) does not match current branch tip/
```

- **Restoration**: Restored commit hash comparison in `pr_create.ts`. Test passed (3/3 passed).

---

### M-B3: Merge Transaction Operator Approval Precondition
- **Target Guard**: `if (!task.approved_at || !task.approved_by)` check in `handlePrMerge` (`engine/delivery/pr_merge.ts:58`).
- **Mutation Applied**: Commented out operator approval check inside `handlePrMerge`'s synchronous transaction block.
- **Catching Test**: `test/integration/t44_pr_merge.test.ts` > `T44: pr.merge Job Integration Test & Real Prune Path (B-7) > refuses when operator approval is missing`.
- **Execution Result**:

```
 ❯ test/integration/t44_pr_merge.test.ts (3 tests | 1 failed) 1300ms
   × T44: pr.merge Job Integration Test & Real Prune Path (B-7) > refuses when operator approval is missing
     → expected [Function] to throw error matching /lacks operator approval/

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/integration/t44_pr_merge.test.ts > T44: pr.merge Job Integration Test & Real Prune Path (B-7) > refuses when operator approval is missing
AssertionError: expected [Function] to throw error matching /lacks operator approval/
```

- **Restoration**: Restored approval check in `pr_merge.ts`. Test passed (3/3 passed).

---

### M-B4: Real Worktree Prune Execution
- **Target Guard**: `await workspaceProvider.prune(db, taskId)` call in `handlePrMerge` (`engine/delivery/pr_merge.ts:114`).
- **Mutation Applied**: Commented out post-commit `prune` call in `handlePrMerge`.
- **Catching Test**: `test/integration/t44_pr_merge.test.ts` > `T44: pr.merge Job Integration Test & Real Prune Path (B-7) > happy path: merges PR inside transaction, transitions to done, sets merged_at/by, and prunes worktree (B-7)`.
- **Execution Result**:

```
 ❯ test/integration/t44_pr_merge.test.ts (3 tests | 1 failed) 2100ms
   × T44: pr.merge Job Integration Test & Real Prune Path (B-7) > happy path: merges PR inside transaction, transitions to done, sets merged_at/by, and prunes worktree (B-7)
     → expected 'ready' to be 'removed'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/integration/t44_pr_merge.test.ts > T44: pr.merge Job Integration Test & Real Prune Path (B-7) > happy path: merges PR inside transaction, transitions to done, sets merged_at/by, and prunes worktree (B-7)
AssertionError: expected 'ready' to be 'removed'
```

- **Restoration**: Restored `prune` call in `pr_merge.ts`. Test passed cleanly (3/3 passed).
