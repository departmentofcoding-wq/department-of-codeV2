# Phase 4 Mutation Evidence Ledger

This file records mutation evidence for Phase 4 deliverables. Every PR names the guard it broke and the test that caught it.

---

## Stream A — Senior Review Gates & Junior Dispatch Prompt

| ID | Guard Mutated | Mutation Description | Test That Caught It | Log Evidence / Output |
|---|---|---|---|---|
| M-A1 | Plan Rubric Refusal Gate | Removed deterministic rubric check before `callModel` in `handleSeniorReviewPlan` | `test/integration/t39_t40_plan_review.test.ts` (T39) | `AssertionError: expected mockClient.callHistory.length (1) to be 0` |
| M-A2 | Ceiling Entry-Guard | Removed entry-guard check at top of `handleSeniorReviewPlan` | `test/integration/t39_t40_plan_review.test.ts` (T40) | `AssertionError: expected task plan_rounds (4) to be 3` |
| M-A3 | Work Review Preconditions Gate | Removed `verifier_exit_code === 0` precondition check in `handleSeniorReviewWork` | `test/integration/t41_work_review.test.ts` (T41) | `AssertionError: expected mockClient.callHistory.length (1) to be 0` |
| M-A4 | Branch Tip Commit Recording | Changed `reviewed_commit` insertion to store `worktree.base_commit` instead of tip commit `getBranchTipCommit` | `test/integration/t41_work_review.test.ts` (T41) | `AssertionError: expected reviewed_commit ('3a1f9...') to equal newTipCommit ('8b9c2...')` |

---

## Stream B — Operator Approval Door & Delivery (PR + Merge)

| ID | Guard Mutated | Mutation Description | Test That Caught It | Log Evidence / Output |
|---|---|---|---|---|
| M-B1 | Verifier Exit Code Approval Gate | Removed `verifier_exit_code === 0` check in `approveTask` (`engine/state/machine.ts`) | `test/integration/t42_approval_door.test.ts` (T42) | `AssertionError: expected approveTaskInteractive to throw error matching /cannot be approved because verifier exit code/` |
| M-B2 | PR Creation Verdict Commit Hash Match | Removed `reviewed_commit === currentTip` check in `handlePrCreate` (`engine/delivery/pr_create.ts`) | `test/integration/t43_pr_create.test.ts` (T43) | `AssertionError: expected handlePrCreate to throw error matching /work review commit (outdated-hash-999) does not match current branch tip/` |
| M-B3 | Merge Transaction Approval Precondition | Removed `approved_at` / `approved_by` validation inside merge transaction in `handlePrMerge` (`engine/delivery/pr_merge.ts`) | `test/integration/t44_pr_merge.test.ts` (T44) | `AssertionError: expected handlePrMerge to throw error matching /lacks operator approval/` |
| M-B4 | Real Worktree Prune Execution | Changed `prune` call in `handlePrMerge` to be a no-op | `test/integration/t44_pr_merge.test.ts` (T44) | `AssertionError: expected wtRowAfter.status ('ready') to be 'removed'` |
