Work directly on the branch already checked out in the worktree (bureau-wt-05a02b9a-82c5-406d-a58d-5b6bda29cc4c).
Do not create, switch, or rename branches.
2. Senior Review (Round 1) Revisions
2.1 Single Source of Truth for Sendback Decision (No Duplicated Logic)
To prevent predicate drift between engine/verify/job.ts and engine/verify/loop.ts, factor out shared helper functions in engine/verify/loop.ts:
readVerifyCeiling(db: DbConnection): number: Single helper reading verify:fixes:ceiling from bureau_meta with default fallback to 2.
isVerifyFixSendback(task: Pick<BureauTaskRow, 'verify_fixes'>, outcome: VerifyRunResult, ceiling: number): boolean: Returns true iff the outcome failed (exitCode !== 0 || timedOut) AND task.verify_fixes < ceiling.
Both job.ts (for the pre-transaction checkpoint decision) and handleVerifyOutcome (for the DB transition & job enqueue) use these shared helpers (or job.ts reads ceiling/computes isSendback once and passes them via opts).
2.2 Explicit Replacement & Deletion of Post-Transaction Checkpoint
In engine/verify/job.ts, the existing step 5 post-transaction checkpoint block:
ts
is explicitly removed and deleted.
It is replaced in its entirety by the pre-transaction checkpoint awaited before execTransaction. When execTransaction commits, the worktree is already cleanly committed and junior.dispatch is claimable with zero race against a dirty worktree.
3. Enumerable Scope (Components and Files to Change)
3.1 Verify Job & Seam Sequencing
engine/verify/job.ts
:
Read ceiling = readVerifyCeiling(ctx.db).
Evaluate isSendback = isVerifyFixSendback(task, outcome, ceiling).
If isSendback, await provider.checkpoint(ctx.db, taskId, VERIFIER_ATTRIBUTION, 'verify-failure-sendback') before ctx.db.execTransaction (in a try/catch journaling checkpoint_failed on error).
Inside ctx.db.execTransaction: record bureau_verify_runs row, journal verify_run_completed, invoke handleVerifyOutcome(ctx.db, taskId, outcome, VERIFIER_ATTRIBUTION, { tip, ceiling, isSendback, folder: workspaceHandle.path }), and call completeJob(ctx.db, ctx.job.id).
Delete the post-transaction checkpoint block.
3.2 Verify Loop & Fix Dispatch
engine/verify/loop.ts
:
Export readVerifyCeiling(db: DbConnection): number.
Export isVerifyFixSendback(task: Pick<BureauTaskRow, 'verify_fixes'>, outcome: VerifyRunResult, ceiling: number): boolean.
Export buildVerifyFixPrompt(task: BureauTaskRow, outcome: VerifyRunResult, round: number, ceiling: number, projectInfo?: { name: string; path: string }): string:
Embeds verifier exit code, timeout state, stdout/stderr tails, failed stages, task title/intent/spec/acceptance/verify_cmd, and JUNIOR_COMPLETION_INSTRUCTION.
Extend VerifyOutcomeOptions to accept { tip?: string; ceiling?: number; isSendback?: boolean; junior?: string; juniorModel?: string; folder?: string; seniorId?: string; seniorModel?: string }.
Update handleVerifyOutcome:
Use ceiling = opts.ceiling ?? readVerifyCeiling(db) and isSendback = opts.isSendback ?? isVerifyFixSendback(task, outcome, ceiling).
If isSuccess:
If opts.tip indicates stale approval (approval.reviewed_commit !== opts.tip), transition to claimed with action verify_passed_stale_approval, enqueue work.cycle pinned to assignJunior({ taskId }), journal guardrail, notify operator, return { isSuccess: false, isSendback: false }.
Otherwise, update verifier_exit_code = 0, transition needs-review, return { isSuccess: true, isSendback: false }.
If isSendback:
Increment task.verify_fixes by 1.
Transition verifying -> claimed with action verify_failed_sendback.
Resolve junior via (opts.junior || assignJunior({ taskId })).toUpperCase().
Insert bureau_dispatches row (actor_role: 'junior-engineer', provider: 'antigravity', model: opts.juniorModel ?? 'unspecified', status 'pending').
Enqueue junior.dispatch job with payload: { dispatchId, prompt, junior, freshConversation: false, chainWorkReview: true, folder, workSeniorId, workSeniorModel }.
Return { isSuccess: false, isSendback: true }.
If ceiling reached (!isSuccess && !isSendback):
Transition verifying -> blocked with action verify_ceiling_reached.
Journal guardrail span (verify_fixes ceiling reached).
Call notifyOperator(taskId, 'verify_fixes ceiling reached').
Return { isSuccess: false, isSendback: false }.
3.3 Documentation & Mutation Records
docs/plan-pre-phase8-remaining.md
:
Update Section N1(a) to record option (a) as landed and verified.
docs/mutation-evidence-phase8.md
:
Record mutation test runs and evidence for M-N1a.
4. Tests to Add & Mutation Evidence
4.1 Unit Tests: test/unit/tc_verify_fix_dispatch.test.ts
Shared predicate & ceiling helper tests:
Verify readVerifyCeiling reads from bureau_meta and defaults to 2 when absent/malformed.
Verify isVerifyFixSendback returns true for failure under ceiling and false for success or failure at/above ceiling.
Verify failure dispatches junior.dispatch:
Assert handleVerifyOutcome under ceiling inserts a row in bureau_dispatches and enqueues a junior.dispatch job (not verify.run).
Assert payload contains chainWorkReview: true, freshConversation: false, valid dispatchId, and non-empty prompt.
Deterministic junior assignment:
Assert that an unpinned verify failure on Task A (3756ec6e-...) enqueues junior.dispatch with junior: 'A', while Task B (b55e2fda-...) enqueues with junior: 'B'.
Assert explicit opts.junior override is respected.
Verify fix prompt format:
Assert buildVerifyFixPrompt contains exit code, stdout/stderr tails, failing stages, task title/spec/acceptance, and BUREAU-JUNIOR-COMPLETE completion instruction.
Ceiling enforcement:
Assert that at verify_fixes >= ceiling, task transitions to blocked, operator is notified, guardrail span is journaled, and no junior.dispatch job is enqueued.
4.2 Integration Tests: test/integration/tc_verify_fix_dispatch_flow.test.ts
Full fix-and-re-review lifecycle & pre-transaction checkpoint:
Execute a failing verify.run job through executeVerifyRunJob.
Assert verify-failure-sendback checkpoint was created on the workspace provider before junior.dispatch became claimable.
Execute handleJuniorDispatch (with mocked driver returning an updated walkthrough).
Assert work.cycle is enqueued due to chainWorkReview: true.
Execute runWorkReviewCycle returning approved.
Assert flow reaches worktree.prepare / verify.run.
Re-run verify.run with passing outcome and assert transition to needs-review.
Stale approval protection across fix dispatch:
Verify that if the junior's fix moves the worktree branch tip past the reviewed commit, M-N1b stale approval check triggers re-review instead of prematurely reaching needs-review.
4.3 Test Suite Adaptations
Update test/integration/t25_exit_sentence_loop.test.ts and test/integration/t29_wx_end_to_end.test.ts to reflect that verify failure enqueues junior.dispatch fix rounds on send-back, rather than bare verify.run retries.
4.4 Mutation Evidence to Record
Mutation M-N1a1 (Verify failure job kind):
Mutate handleVerifyOutcome to enqueue verify.run instead of junior.dispatch.
Expected: tc_verify_fix_dispatch.test.ts fails asserting job kind === junior.dispatch.
Mutation M-N1a2 (Junior assignment policy):
Mutate handleVerifyOutcome to hardcode junior: 'A' instead of assignJunior({ taskId }).
Expected: tc_verify_fix_dispatch.test.ts fails on Task B assignment test.
Mutation M-N1a3 (Chain work review flag):
Mutate handleVerifyOutcome to omit chainWorkReview: true in payload.
Expected: tc_verify_fix_dispatch_flow.test.ts fails when dispatch does not chain into work.cycle.
5. Walkthrough / Verification Plan
Static Analysis & Type Checking:
Run npx tsc --noEmit to verify type cleanliness across engine, tests, and contracts.
Unit & Integration Test Verification:
Run npx vitest run test/unit/tc_verify_fix_dispatch.test.ts
Run npx vitest run test/integration/tc_verify_fix_dispatch_flow.test.ts
Run npx vitest run test/integration/t25_exit_sentence_loop.test.ts
Run npx vitest run test/integration/t29_wx_end_to_end.test.ts
Run full test suite: npm test across all 120+ test files to confirm 100% green.
Mutation Testing Execution:
Apply mutations M-N1a1, M-N1a2, and M-N1a3 sequentially, verify tests fail as expected, revert each mutation, and document test failure logs in mutation evidence.
Documentation Audit:
Verify docs/plan-pre-phase8-remaining.md is updated.
Implementation Plan
Updated implementation plan addressing senior review round 1 feedback: shared sendback predicate and explicit deletion of post-transaction checkpoint.
Proceed
7:07 PM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Implementation Plan: N1(a) Real Junior Verify-Fix Dispatch on Verify Failure The revised implementation plan addressing all senior review points is documented in implementation_plan.md. Branch Requirement Work directly on the branch already checked out in the worktree (bureau-wt-05a02b9a-82c5-406d-a58d-5b6bda29cc4c). Do not create, switch, or rename branches. Senior Review (Round 1) Revisions 2.1 Single Source of Truth for Sendback Decision (No Duplicated Logic) To prevent predicate drift between engine/verify/job.ts and engine/verify/loop.ts, factor out shared helper functions in engine/verify/loop.ts: readVerifyCeiling(db: DbConnection): number: Single helper reading verify:fixes:ceiling from bureau_meta with default fallback to 2. isVerifyFixSendback(task: Pick, outcome: VerifyRunResult, ceiling: number): boolean: Returns true iff the outcome failed (exitCode !== 0 || timedOut) AND task.verify_fixes , outcome: VerifyRunResult, ceiling: number): boolean. Export buildVerifyFixPrompt(task: BureauTaskRow, outcome: VerifyRunResult, round: number, ceiling: number, projectInfo?: { name: string; path: string }): string: Embeds verifier exit code, timeout state, stdout/stderr tails, failed stages, task title/intent/spec/acceptance/verifycmd, and JUNIORCOMPLETION_INSTRUCTION. Extend VerifyOutcomeOptions to accept { tip?: string; ceiling?: number; isSendback?: boolean; junior?: string; juniorModel?: string; folder?: string; seniorId?: string; seniorModel?: string }. Update handleVerifyOutcome: Use ceiling = opts.ceiling ?? readVerifyCeiling(db) and isSendback = opts.isSendback ?? isVerifyFixSendback(task, outcome, ceiling). If isSuccess: If opts.tip indicates stale approval (approval.reviewedcommit !== opts.tip), transition to claimed with action verifypassedstaleapproval, enqueue work.cycle pinned to assignJunior({ taskId }), journal guardrail, notify operator, return { isSuccess: false, isSendback: false }. Otherwise, update verifierexitcode = 0, transition needs-review, return { isSuccess: true, isSendback: false }. If isSendback: Increment task.verify_fixes by 1. Transition verifying -> claimed with action verifyfailedsendback. Resolve junior via (opts.junior || assignJunior({ taskId })).toUpperCase(). Insert bureaudispatches row (actorrole: 'junior-engineer', provider: 'antigravity', model: opts.juniorModel ?? 'unspecified', status 'pending'). Enqueue junior.dispatch job with payload: { dispatchId, prompt, junior, freshConversation: false, chainWorkReview: true, folder, workSeniorId, workSeniorModel }. Return { isSuccess: false, isSendback: true }. If ceiling reached (!isSuccess && !isSendback): Transition verifying -> blocked with action verifyceilingreached. Journal guardrail span (verify_fixes ceiling reached). Call notifyOperator(taskId, 'verify_fixes ceiling reached'). Return { isSuccess: false, isSendback: false }. 3.3 Documentation & Mutation Records docs/plan-pre-phase8-remaining.md: Update Section N1(a) to record option (a) as landed and verified. docs/mutation-evidence-phase8.md: Record mutation test runs and evidence for M-N1a. Tests to Add & Mutation Evidence 4.1 Unit Tests: test/unit/tcverifyfix_dispatch.test.ts Shared predicate & ceiling helper tests: Verify readVerifyCeiling reads from bureau_meta and defaults to 2 when absent/malformed. Verify isVerifyFixSendback returns true for failure under ceiling and false for success or failure at/above ceiling. Verify failure dispatches junior.dispatch: Assert handleVerifyOutcome under ceiling inserts a row in bureau_dispatches and enqueues a junior.dispatch job (not verify.run). Assert payload contains chainWorkReview: true, freshConversation: false, valid dispatchId, and non-empty prompt. Deterministic junior assignment: Assert that an unpinned verify failure on Task A (3756ec6e-...) enqueues junior.dispatch with junior: 'A', while Task B (b55e2fda-...) enqueues with junior: 'B'. Assert explicit opts.junior override is respected. Verify fix prompt format: Assert buildVerifyFixPrompt contains exit code, stdout/stderr tails, failing stages, task title/spec/acceptance, and BUREAU-JUNIOR-COMPLETE completion instruction. Ceiling enforcement: Assert that at verify_fixes >= ceiling, task transitions to blocked, operator is notified, guardrail span is journaled, and no junior.dispatch job is enqueued. 4.2 Integration Tests: test/integration/tcverifyfixdispatchflow.test.ts Full fix-and-re-review lifecycle & pre-transaction checkpoint: Execute a failing verify.run job through executeVerifyRunJob. Assert verify-failure-sendback checkpoint was created on the workspace provider before junior.dispatch became claimable. Execute handleJuniorDispatch (with mocked driver returning an updated walkthrough). Assert work.cycle is enqueued due to chainWorkReview: true. Execute runWorkReviewCycle returning approved. Assert flow reaches worktree.prepare / verify.run. Re-run verify.run with passing outcome and assert transition to needs-review. Stale approval protection across fix dispatch: Verify that if the junior's fix moves the worktree branch tip past the reviewed commit, M-N1b stale approval check triggers re-review instead of prematurely reaching needs-review. 4.3 Test Suite Adaptations Update test/integration/t25exitsentenceloop.test.ts and test/integration/t29wxendto_end.test.ts to reflect that verify failure enqueues junior.dispatch fix rounds on send-back, rather than bare verify.run retries. 4.4 Mutation Evidence to Record Mutation M-N1a1 (Verify failure job kind): Mutate handleVerifyOutcome to enqueue verify.run instead of junior.dispatch. Expected: tcverifyfix_dispatch.test.ts fails asserting job kind === junior.dispatch. Mutation M-N1a2 (Junior assignment policy): Mutate handleVerifyOutcome to hardcode junior: 'A' instead of assignJunior({ taskId }). Expected: tcverifyfix_dispatch.test.ts fails on Task B assignment test. Mutation M-N1a3 (Chain work review flag): Mutate handleVerifyOutcome to omit chainWorkReview: true in payload. Expected: tcverifyfixdispatchflow.test.ts fails when dispatch does not chain into work.cycle. Walkthrough / Verification Plan Static Analysis & Type Checking: Run npx tsc --noEmit to verify type cleanliness across engine, tests, and contracts. Unit & Integration Test Verification: Run npx vitest run test/unit/tcverifyfix_dispatch.test.ts Run npx vitest run test/integration/tcverifyfixdispatchflow.test.ts Run npx vitest run test/integration/t25exitsentence_loop.test.ts Run npx vitest run test/integration/t29wxendtoend.test.ts Run full test suite: npm test across all 120+ test files to confirm 100% green. Mutation Testing Execution: Apply mutations M-N1a1, M-N1a2, and M-N1a3 sequentially, verify tests fail as expected, revert each mutation, and document test failure logs in mutation evidence. Documentation Audit: Verify docs/plan-pre-phase8-remaining.md is updated.
Completion signal (required): when — and only when — the requested work is fully done and this is your FINAL message for it, end that message with this exact final line on its own:
BUREAU-JUNIOR-COMPLETE
While your own terminal commands or test runs are still executing you are NOT done — wait for them, then continue; never print that line before all work and verification are complete.
7:11 PM
Worked for 12m
Summary of Completed Work
N1(a): Real Junior Verify-Fix Dispatch on Verify Failure
Engine Logic & Sequencing:
In
engine/verify/loop.ts
, implemented readVerifyCeiling, isVerifyFixSendback, and buildVerifyFixPrompt.
On a verifier failure under the budget ceiling, handleVerifyOutcome now transitions verifying -> claimed, inserts a bureau_dispatches row, and enqueues a junior.dispatch fix round pinned deterministically to assignJunior({ taskId }) with chainWorkReview: true.
When the fix completes, chainWorkReview: true automatically enqueues a senior work review (work.cycle) before the code can advance to needs-review.
In
engine/verify/job.ts
, the sendback checkpoint is awaited pre-transaction before execTransaction commits, guaranteeing the worktree is cleanly committed before junior.dispatch is claimable. The legacy post-transaction checkpoint was removed.
The ceiling termination backstop (blocked state + operator notification) is strictly preserved.
Tests Added & Adapted:
Added unit tests in
test/unit/tc_verify_fix_dispatch.test.ts
(6/6 passing).
Added end-to-end integration test in
test/integration/tc_verify_fix_dispatch_flow.test.ts
(2/2 passing).
Adapted
test/integration/t25_exit_sentence_loop.test.ts
and
test/integration/t29_wx_end_to_end.test.ts
to verify fix dispatch rounds on sendback and ceiling exhaustion.
Documentation & Mutation Records:
Updated
docs/plan-pre-phase8-remaining.md
to record N1(a) as completed.
Documented mutations M-N1a1 (job kind), M-N1a2 (junior assignment policy), and M-N1a3 (chain work review flag) in
docs/mutation-evidence-phase8.md
.
Verification:
Full test suite: 123/123 test files passed (676/676 tests).
Build: npm run build / npx tsc --noEmit clean.
Detailed walkthrough documented in
walkthrough.md
.
BUREAU-JUNIOR-COMPLETE
Walkthrough
Walkthrough for N1(a): real junior verify-fix dispatch on verify failure
8 files changed
+687
-60
Review
7:11 PM
8 Files With Changes
Reject all
Accept all
+126
-15
loop.ts
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\engine\verify\loop.ts
+31
-20
job.ts
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\engine\verify\job.ts
+274
-0
tc_verify_fix_dispatch.test.ts
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\test\unit\tc_verify_fix_dispatch.test.ts
+167
-0
tc_verify_fix_dispatch_flow.test.ts
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\test\integration\tc_verify_fix_dispatch_flow.test.ts
+6
-6
t25_exit_sentence_loop.test.ts
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\test\integration\t25_exit_sentence_loop.test.ts
+7
-7
t29_wx_end_to_end.test.ts
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\test\integration\t29_wx_end_to_end.test.ts
+12
-12
plan-pre-phase8-remaining.md
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\docs\plan-pre-phase8-remaining.md
+58
-0
mutation-evidence-phase8.md
d:\Dept of code v2\.bureau-worktrees\05a02b9a-82c5-406d-a58d-5b6bda29cc4c\docs\mutation-evidence-phase8.md
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Waiting for the baseline tests and build to finish running...
