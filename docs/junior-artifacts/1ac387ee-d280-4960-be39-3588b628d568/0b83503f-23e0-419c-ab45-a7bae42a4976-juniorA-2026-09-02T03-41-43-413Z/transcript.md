===== APPROVED PLAN =====
9:03 AM
Worked for 17s
Implementation Plan: N15 — Flow Senior Reviews Resilience to Transient Claude CLI Stalls
1. Working Branch & Worktree Integrity
Branch/Worktree: Work directly on the branch already checked out in the worktree (bureau-wt-1ac387ee-d280-4960-be39-3588b628d568).
Invariant: Do not create, switch, or rename branches.
2. Enumerable Scope (Components & Files)
Component: Flow Review Cycles (engine/flow/)
[MODIFY]
engine/flow/work_review_cycle.ts
Update WorkReviewResult union type (lines 61–86 in work_review_cycle.ts) to include:
ts
| { outcome: 'blocked'; reason: 'senior_stall_exhausted'; senior: string; attempts: number }
Implement a bounded retry loop around the senior.review(...) call site in runWorkReviewCycle.
Configurable budget via bureau_meta key senior:stall_retries / env SENIOR_STALL_RETRIES (helper readSeniorStallRetries(db), default: 2 retries / 3 total attempts).
On senior stall, harness error, subprocess failure, or uncaptured review:
If retry budget remains: log a guardrail journal span (action: 'senior_review_retry', attempt index, error reason), and retry the senior.review(...) call.
Each retry is a fresh review attempt (for Claude CLI, a fresh subprocess is spawned; for CDP/ZCode seniors, freshConversation: true is passed).
Maintain strict fail-closed parsing (parseVerdict / detectUncapturedReview): partial/interrupted output is never recorded or parsed as a verdict.
On retry budget exhaustion:
Refresh bureau_tasks row; if task.state === 'claimed', transition claimed -> blocked with actor role senior-engineer (reason: 'senior_stall_exhausted').
Record guardrail journal span (action: 'senior_stall_exhausted', attempts, seniorId).
Notify operator via notifyOperator.
Return { outcome: 'blocked', reason: 'senior_stall_exhausted', senior: seniorId, attempts } so the job finishes without an unhandled throw or leaving the task stranded.
[MODIFY]
engine/flow/plan_review_cycle.ts
Update PlanCycleResult union type (lines 68–102 in plan_review_cycle.ts) to include:
ts
| { outcome: 'blocked'; reason: 'senior_stall_exhausted'; senior: string; attempts: number }
Implement the symmetric bounded retry loop around senior.review(...) in runPlanReviewCycle.
Retain the junior-authored plan (planText) and draft row across retries — retry ONLY the senior review call without re-prompting the junior.
On retry budget exhaustion:
Re-Armable State Transition (Two-Hop Resolution):
Refresh bureau_tasks row.
If task.state === 'queued', execute the two legal hops:
queued -> claimed with attribution senior-engineer (reason: 'senior_stall_exhaustion_claim').
claimed -> blocked with actor role senior-engineer (reason: 'senior_stall_exhausted').
If task.state === 'claimed', transition directly claimed -> blocked with actor role senior-engineer (reason: 'senior_stall_exhausted').
In both cases, the task lands cleanly in blocked, fully re-armable via rearmTask(db, taskId, attribution, { reenqueueKind: 'plan.cycle' }).
Record guardrail journal span (action: 'senior_stall_exhausted', attempts, seniorId).
Notify operator via notifyOperator.
Return { outcome: 'blocked', reason: 'senior_stall_exhausted', senior: seniorId, attempts }.
Component: Constants & Meta Configuration (engine/contract/)
[MODIFY]
engine/contract/constants.ts
Define REVIEW_PR_META_KEYS.SENIOR_STALL_RETRIES = 'senior:stall_retries'.
Define DEFAULT_SENIOR_STALL_RETRIES = 2.
Component: State & Re-Arm Verification (engine/state/)
Verify
engine/state/machine.ts
:
Ensure rearmTask(db, taskId, attribution, { reenqueueKind: 'work.cycle' | 'plan.cycle' }) transitions blocked -> claimed and enqueues the cycle job.
3. Tests & Mutation Evidence
Integration Tests
[NEW] test/integration/tc_senior_stall_resilience.test.ts
Transient Stall Recovery in work.cycle (N-1 stalls then success):
Fake senior driver throws stall error on attempt 1, returns approve verdict on attempt 2.
Verify: work.cycle retries, records a retry guardrail span, succeeds with outcome: 'approved', and exactly 1 bureau_work_reviews row is recorded with correct attribution.
Transient Stall Recovery in plan.cycle (N-1 stalls then success):
Fake senior driver throws stall error on attempt 1, returns approve verdict on attempt 2.
Verify: plan.cycle retries senior review using the already-authored plan, succeeds with outcome: 'approved', and enqueues junior.dispatch for implementation.
Stall Exhaustion in work.cycle (state === 'claimed'):
Fake senior driver persistently stalls across all attempts.
Verify: task transitions from claimed -> blocked, senior_stall_exhausted guardrail span recorded, operator notified, outcome is 'blocked', and rearmTask(..., { reenqueueKind: 'work.cycle' }) successfully transitions blocked -> claimed and enqueues work.cycle.
Stall Exhaustion in plan.cycle with queued task (Two-hop queued -> claimed -> blocked):
Task starts in queued state; fake senior persistently stalls.
Verify: task transitions through queued -> claimed -> blocked, lands in blocked, exhaustion journal span recorded, operator notified, outcome is 'blocked'.
Operator Re-Arm Recovery on plan.cycle exhaustion (rearmTask):
After plan.cycle stall exhaustion leaves task blocked, execute rearmTask(db, taskId, attribution, { reenqueueKind: 'plan.cycle' }).
Verify: task transitions blocked -> claimed, plan.cycle job is enqueued in bureau_jobs, and subsequent non-stalling run completes successfully.
Stall Exhaustion in plan.cycle with claimed task:
Task already in claimed state; fake senior persistently stalls.
Verify: task transitions claimed -> blocked directly, lands in blocked.
Fail-Closed Guarantee on Stalls:
Partial stdout/stderr on stall is never parsed into a fabricated or phantom verdict.
Mutation Evidence (docs/mutation-evidence-phase8.md)
M-N15a (Retry Bound Guard):
Mutate retry loop condition (e.g. retries = 0 / force immediate break).
Catcher: tc_senior_stall_resilience.test.ts (transient stall recovery test fails on first stall).
M-N15b (Blocked-on-Exhaustion State Guard):
Mutate exhaustion path in work_review_cycle.ts / plan_review_cycle.ts to omit transition(db, task.id, 'blocked', ...).
Catcher: tc_senior_stall_resilience.test.ts (stall exhaustion assertion expecting blocked fails with claimed or queued).
4. Walkthrough & Verification Plan
Automated Verification
Run TypeScript type check:
powershell
npx tsc --noEmit
Run new resilience suite:
powershell
npx vitest run test/integration/tc_senior_stall_resilience.test.ts
Run existing cycle test suites:
powershell
npx vitest run test/integration/tc_work_cycle.test.ts test/integration/tc_plan_cycle.test.ts
Run full test suite:
powershell
npm test
Walkthrough & Documentation
Document in walkthrough.md:
Choice of in-cycle bounded retry loop: executes within the job's 45-minute timeout window without restarting junior plan authoring or duplicating junior tokens.
Transactional auditability: journal spans recorded for each retry attempt and final exhaustion.
Two-hop queued -> claimed -> blocked transition for plan.cycle stall exhaustion, ensuring rearmability via rearmTask.
Record M-N15a and M-N15b mutation tests, failure logs, and restoration in docs/mutation-evidence-phase8.md.
Implementation Plan
Revised implementation plan for N15 addressing all senior review points: two-hop legal state transition for queued-state stall exhaustion (queued -> claimed -> blocked), accurate result union locations in flow cycle files, and detailed design rationale for in-cycle bounded retries and journal-tracked attempts.
Proceed
9:03 AM
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
Implementation Plan: N15 — Flow Senior Reviews Resilience to Transient Claude CLI Stalls Working Branch & Worktree Integrity Branch/Worktree: Work directly on the branch already checked out in the worktree (bureau-wt-1ac387ee-d280-4960-be39-3588b628d568). Invariant: Do not create, switch, or rename branches. Enumerable Scope (Components & Files) Component: Flow Review Cycles (engine/flow/) [MODIFY] engine/flow/workreviewcycle.ts Update WorkReviewResult union type (lines 61–86 in workreviewcycle.ts) to include: | { outcome: 'blocked'; reason: 'seniorstallexhausted'; senior: string; attempts: number } Implement a bounded retry loop around the senior.review(...) call site in runWorkReviewCycle. Configurable budget via bureaumeta key senior:stallretries / env SENIORSTALLRETRIES (helper readSeniorStallRetries(db), default: 2 retries / 3 total attempts). On senior stall, harness error, subprocess failure, or uncaptured review: If retry budget remains: log a guardrail journal span (action: 'seniorreviewretry', attempt index, error reason), and retry the senior.review(...) call. Each retry is a fresh review attempt (for Claude CLI, a fresh subprocess is spawned; for CDP/ZCode seniors, freshConversation: true is passed). Maintain strict fail-closed parsing (parseVerdict / detectUncapturedReview): partial/interrupted output is never recorded or parsed as a verdict. On retry budget exhaustion: Refresh bureautasks row; if task.state === 'claimed', transition claimed -> blocked with actor role senior-engineer (reason: 'seniorstall_exhausted'). Record guardrail journal span (action: 'seniorstallexhausted', attempts, seniorId). Notify operator via notifyOperator. Return { outcome: 'blocked', reason: 'seniorstallexhausted', senior: seniorId, attempts } so the job finishes without an unhandled throw or leaving the task stranded. [MODIFY] engine/flow/planreviewcycle.ts Update PlanCycleResult union type (lines 68–102 in planreviewcycle.ts) to include: | { outcome: 'blocked'; reason: 'seniorstallexhausted'; senior: string; attempts: number } Implement the symmetric bounded retry loop around senior.review(...) in runPlanReviewCycle. Retain the junior-authored plan (planText) and draft row across retries — retry ONLY the senior review call without re-prompting the junior. On retry budget exhaustion: Re-Armable State Transition (Two-Hop Resolution): Refresh bureau_tasks row. If task.state === 'queued', execute the two legal hops: queued -> claimed with attribution senior-engineer (reason: 'seniorstallexhaustion_claim'). claimed -> blocked with actor role senior-engineer (reason: 'seniorstallexhausted'). If task.state === 'claimed', transition directly claimed -> blocked with actor role senior-engineer (reason: 'seniorstallexhausted'). In both cases, the task lands cleanly in blocked, fully re-armable via rearmTask(db, taskId, attribution, { reenqueueKind: 'plan.cycle' }). Record guardrail journal span (action: 'seniorstallexhausted', attempts, seniorId). Notify operator via notifyOperator. Return { outcome: 'blocked', reason: 'seniorstallexhausted', senior: seniorId, attempts }. Component: Constants & Meta Configuration (engine/contract/) [MODIFY] engine/contract/constants.ts Define REVIEWPRMETAKEYS.SENIORSTALLRETRIES = 'senior:stallretries'. Define DEFAULTSENIORSTALL_RETRIES = 2. Component: State & Re-Arm Verification (engine/state/) Verify engine/state/machine.ts: Ensure rearmTask(db, taskId, attribution, { reenqueueKind: 'work.cycle' | 'plan.cycle' }) transitions blocked -> claimed and enqueues the cycle job. Tests & Mutation Evidence Integration Tests [NEW] test/integration/tcseniorstall_resilience.test.ts Transient Stall Recovery in work.cycle (N-1 stalls then success): Fake senior driver throws stall error on attempt 1, returns approve verdict on attempt 2. Verify: work.cycle retries, records a retry guardrail span, succeeds with outcome: 'approved', and exactly 1 bureauworkreviews row is recorded with correct attribution. Transient Stall Recovery in plan.cycle (N-1 stalls then success): Fake senior driver throws stall error on attempt 1, returns approve verdict on attempt 2. Verify: plan.cycle retries senior review using the already-authored plan, succeeds with outcome: 'approved', and enqueues junior.dispatch for implementation. Stall Exhaustion in work.cycle (state === 'claimed'): Fake senior driver persistently stalls across all attempts. Verify: task transitions from claimed -> blocked, seniorstallexhausted guardrail span recorded, operator notified, outcome is 'blocked', and rearmTask(..., { reenqueueKind: 'work.cycle' }) successfully transitions blocked -> claimed and enqueues work.cycle. Stall Exhaustion in plan.cycle with queued task (Two-hop queued -> claimed -> blocked): Task starts in queued state; fake senior persistently stalls. Verify: task transitions through queued -> claimed -> blocked, lands in blocked, exhaustion journal span recorded, operator notified, outcome is 'blocked'. Operator Re-Arm Recovery on plan.cycle exhaustion (rearmTask): After plan.cycle stall exhaustion leaves task blocked, execute rearmTask(db, taskId, attribution, { reenqueueKind: 'plan.cycle' }). Verify: task transitions blocked -> claimed, plan.cycle job is enqueued in bureau_jobs, and subsequent non-stalling run completes successfully. Stall Exhaustion in plan.cycle with claimed task: Task already in claimed state; fake senior persistently stalls. Verify: task transitions claimed -> blocked directly, lands in blocked. Fail-Closed Guarantee on Stalls: Partial stdout/stderr on stall is never parsed into a fabricated or phantom verdict. Mutation Evidence (docs/mutation-evidence-phase8.md) M-N15a (Retry Bound Guard): Mutate retry loop condition (e.g. retries = 0 / force immediate break). Catcher: tcseniorstall_resilience.test.ts (transient stall recovery test fails on first stall). M-N15b (Blocked-on-Exhaustion State Guard): Mutate exhaustion path in workreviewcycle.ts / planreviewcycle.ts to omit transition(db, task.id, 'blocked', ...). Catcher: tcseniorstall_resilience.test.ts (stall exhaustion assertion expecting blocked fails with claimed or queued). Walkthrough & Verification Plan Automated Verification Run TypeScript type check: npx tsc --noEmit Run new resilience suite: npx vitest run test/integration/tcseniorstall_resilience.test.ts Run existing cycle test suites: npx vitest run test/integration/tcworkcycle.test.ts test/integration/tcplancycle.test.ts Run full test suite: npm test Walkthrough & Documentation Document in walkthrough.md: Choice of in-cycle bounded retry loop: executes within the job's 45-minute timeout window without restarting junior plan authoring or duplicating junior tokens. Transactional auditability: journal spans recorded for each retry attempt and final exhaustion. Two-hop queued -> claimed -> blocked transition for plan.cycle stall exhaustion, ensuring rearmability via rearmTask. Record M-N15a and M-N15b mutation tests, failure logs, and restoration in docs/mutation-evidence-phase8.md.
Completion signal (required): when — and only when — the requested work is fully done and this is your FINAL message for it, end that message with this exact final line on its own:
BUREAU-JUNIOR-COMPLETE
While your own terminal commands or test runs are still executing you are NOT done — wait for them, then continue; never print that line before all work and verification are complete.
9:06 AM
Worked for 1m
I have launched npx tsc --noEmit and am waiting for the system notification upon its completion.
Check tsc --noEmit finished
Worked for 1m
I have started the full test suite (npm test) and am waiting for it to complete.
Timed
30 seconds
I will wait for the test suite to finish.
Schedule wait timer: Timer has expired
Worked for 7s
Timed
30 seconds
I will wait for the test suite to finish.
Run npm test finished
Worked for 25s
N15: Flow Senior Reviews Resilience to Transient Claude CLI Stalls — Implementation Summary
I have implemented and verified the approved plan for N15, providing resilience against transient senior CLI/CDP stalls during flow review cycles.
What Changed
Constants & Configuration (
constants.ts
):
Added REVIEW_PR_META_KEYS.SENIOR_STALL_RETRIES = 'senior:stall_retries'.
Defined DEFAULT_SENIOR_STALL_RETRIES = 2 (supporting 2 retries / 3 total attempts).
Flow Review Cycles (
work_review_cycle.ts
&
plan_review_cycle.ts
):
Extended WorkReviewResult and PlanCycleResult union types with { outcome: 'blocked', reason: 'senior_stall_exhausted', senior: string, attempts: number }.
Added readSeniorStallRetries(db) helper checking process.env['SENIOR_STALL_RETRIES'] and bureau_meta['senior:stall_retries'].
Wrapped the senior review call site in an in-cycle bounded retry loop. On transient errors (harness stall, crash, uncaptured review), a guardrail journal span is recorded (action: 'senior_review_retry'), and a fresh review attempt (freshConversation: true) is executed.
Preserves junior plan authoring and draft plan rows in plan.cycle across senior retries without repeating junior work or burning junior tokens.
On retry exhaustion:
Transitions tasks in claimed directly to blocked (actor role senior-engineer).
Transitions tasks in queued via two legal hops: queued -> claimed (reason: 'senior_stall_exhaustion_claim'), then claimed -> blocked (reason: 'senior_stall_exhausted').
Logs a senior_stall_exhausted guardrail span, notifies the operator via notifyOperator, and returns { outcome: 'blocked', ... } (leaving the task cleanly re-armable via rearmTask).
Integration Tests (
tc_senior_stall_resilience.test.ts
):
Added 6 integration tests proving transient stall recovery (N-1 stalls then success) in both work.cycle and plan.cycle, stall exhaustion transitions to blocked, journal audit spans, fail-closed guards, operator re-arming via rearmTask, and fresh conversation handling.
Mutation Evidence (
mutation-evidence-phase8.md
):
Recorded mutation evidence for M-N15a (Retry Bound Guard) and M-N15b (Blocked-on-Exhaustion State Guard) with real failure logs and restoration.
Verification
TypeScript Type Check: npx tsc --noEmit exited 0.
Resilience Suite: npx vitest run test/integration/tc_senior_stall_resilience.test.ts passed 6/6 tests.
Cycle Test Suites: npx vitest run test/integration/tc_work_cycle.test.ts test/integration/tc_plan_cycle.test.ts passed 19/19 tests across 2 files.
Full Test Suite: npm test passed 683/683 tests across 124 test files.
Full details documented in
walkthrough.md
.
BUREAU-JUNIOR-COMPLETE
Walkthrough
Walkthrough for N15 implementation: flow senior reviews resilience to transient claude CLI stalls with bounded retries and re-armable failure.
5 files changed
+616
-35
Review
9:06 AM
5 Files With Changes
Reject all
Accept all
+4
-1
constants.ts
d:\Dept of code v2\.bureau-worktrees\1ac387ee-d280-4960-be39-3588b628d568\engine\contract\constants.ts
+94
-7
work_review_cycle.ts
d:\Dept of code v2\.bureau-worktrees\1ac387ee-d280-4960-be39-3588b628d568\engine\flow\work_review_cycle.ts
+104
-8
plan_review_cycle.ts
d:\Dept of code v2\.bureau-worktrees\1ac387ee-d280-4960-be39-3588b628d568\engine\flow\plan_review_cycle.ts
+357
-0
tc_senior_stall_resilience.test.ts
d:\Dept of code v2\.bureau-worktrees\1ac387ee-d280-4960-be39-3588b628d568\test\integration\tc_senior_stall_resilience.test.ts
+38
-0
mutation-evidence-phase8.md
d:\Dept of code v2\.bureau-worktrees\1ac387ee-d280-4960-be39-3588b628d568\docs\mutation-evidence-phase8.md
Ask anything, @ to mention, / for actions
Gemini 3.7 Flash Medium
I will wait for tsc --noEmit to finish.
