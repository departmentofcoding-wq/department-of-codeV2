# Implementation Plan: Journal Completeness (Reconstruct Full Flow from Journal Alone)

## 1. Branch & Execution Constraint
- **Working Branch**: Work directly on the branch already checked out in the worktree (`bureau-wt-05c6edc0-d91c-46fb-9bb1-0f8e1703542d`).
- **Branch Discipline**: Do not create, switch, or rename branches. All changes remain scoped to this worktree.

---

## 2. Enumerable Scope (Components and Files to Change)

### A. Engine Journaling & Core Utilities
1. **[MODIFY] [engine/journal/writer.ts](file:///d:/Dept%20of%20code%20v2/engine/journal/writer.ts)**
   - Ensure `journal()` applies sanitization/redaction (`redactOutput`) and bounds oversized string fields in `detail` using a standard truncation marker `[TRUNCATED: original length N characters]` (e.g. 64KB max per field).
   - Ensure artifact path pointers accompany verbatim text fields in `detail`.
2. **[MODIFY] [engine/journal/narrate.ts](file:///d:/Dept%20of%20code%20v2/engine/journal/narrate.ts)**
   - Extend `narrateEntry` pure mapper to handle all flow span kinds and stage details:
     - `task-filed`: Include task title and verify command.
     - `assignment`: Render assigned junior and senior.
     - `observation`: Handle `plan-authoring`, `junior-implementation`, `verify-fix`, noting junior and reply size/artifacts.
     - `review`: Clearly distinguish `plan-review`, `work-review` (walkthrough), and `diff-review`, reporting verdict and round.
     - `tool`: Handle `verify_run_completed` with exit code and stage breakdown (structural, fail-to-pass, pass-to-pass).
     - `system`: Handle `pr.create` (PR URL/number), `pr.merge`, `backup.push`, `junior_pointed_at_worktree`, and lease operations.
     - `guardrail`: Formulate informative rejection messages.

### B. Flow Phase Audit & Span Detail Enhancement
3. **[MODIFY] [engine/filing/file_task.ts](file:///d:/Dept%20of%20code%20v2/engine/filing/file_task.ts)**
   - In `task-filed` span detail, record full task metadata: `title`, `intent`, `spec`, `acceptance`, `verify_cmd`, `project_id`, `intake_session_id`.
4. **[MODIFY] [engine/flow/plan_review_cycle.ts](file:///d:/Dept%20of%20code%20v2/engine/flow/plan_review_cycle.ts)**
   - In plan authoring `observation` span: ensure verbatim prompt, junior ID, model, artifact paths, and reply head/metrics are recorded.
   - In rubric failure `review` span: record rubric evaluation details and required fixes.
   - In senior review `review` span: record full senior feedback, verdict (`approved` / `revise`), round number, senior ID, model, and plan ID.
5. **[MODIFY] [engine/harness/dispatch-job.ts](file:///d:/Dept%20of%20code%20v2/engine/harness/dispatch-job.ts)**
   - In `observation` span for `junior.dispatch`: ensure verbatim prompt delivered, conversation mode (`continue` | `fresh`), junior ID, model, worktree path, artifact file paths, and transcript/reply excerpts are captured.
6. **[MODIFY] [engine/flow/work_review_cycle.ts](file:///d:/Dept%20of%20code%20v2/engine/flow/work_review_cycle.ts)**
   - In work walkthrough `review` span: record full feedback, round, ceiling, verdict (`approved` | `amend`), senior ID, model, and walkthrough artifact pointers.
   - In REVISE fix dispatch: record fix prompt verbatim in dispatch payload / observation.
7. **[MODIFY] [engine/flow/diff_review_cycle.ts](file:///d:/Dept%20of%20code%20v2/engine/flow/diff_review_cycle.ts)**
   - In `work.diff-review` `review` span: record full feedback, reviewed commit, diff stats, senior ID, model, and verdict (`approved` | `amend`).
8. **[MODIFY] [engine/verify/job.ts](file:///d:/Dept%20of%20code%20v2/engine/verify/job.ts)**
   - In `verify_run_completed` tool span: record the verify command executed, individual stage results (stage name, exit code, skipped), pass counts (before/after), and truncated `stdoutTail` / `stderrTail` excerpts.
9. **[MODIFY] [engine/verify/loop.ts](file:///d:/Dept%20of%20code%20v2/engine/verify/loop.ts)**
   - On verify sendback, record `verify_failed_sendback` transition and verify-fix dispatch with verbatim `fixPrompt`, failure output excerpt, and target junior.
10. **[MODIFY] [engine/delivery/pr_create.ts](file:///d:/Dept%20of%20code%20v2/engine/delivery/pr_create.ts)** & **[engine/delivery/pr_merge.ts](file:///d:/Dept%20of%20code%20v2/engine/delivery/pr_merge.ts)**
   - Ensure PR creation and merge spans record PR URL, PR number, branch name, reviewed commit, and mergedBy attribution.
11. **[MODIFY] [engine/durability/backup_push.ts](file:///d:/Dept%20of%20code%20v2/engine/durability/backup_push.ts)**
   - Ensure `backup.push` spans capture remote, branch, commit, status (`already_on_remote` / `pushed`), and verified tip.

---

## 3. Test Plan & Mutation Evidence

### A. Automated Tests
1. **[NEW] [test/integration/tc_journal_completeness.test.ts](file:///d:/Dept%20of%20code%20v2/test/integration/tc_journal_completeness.test.ts)**
   - Drive an end-to-end fake flow against an isolated temporary database:
     `fileTask` -> `reconcileQueuedTasks` (admission & assignment) -> `plan.cycle` (authoring + senior review) -> `junior.dispatch` (implementation) -> `work.cycle` (walkthrough review) -> `work.diff-review` (diff review) -> `verify.run` -> `pr.create` -> `pr.merge` -> `backup.push` -> operator archive.
   - **Completeness Assertions**:
     - Verify every prompt (plan authoring, implementation, fix, verify-fix) exists verbatim in journal spans.
     - Verify every review round (plan, walkthrough, diff) carries the senior's full feedback.
     - Verify the verify span carries verify command, stage results, and output tail.
     - Verify delivery and operator spans are recorded.
   - **Secret Hygiene & Truncation Assertions**:
     - Inject mock API keys (e.g. `sk-ant-...`, `AIzaSy...`, `BUREAU_SECRET`) in prompts/outputs and assert zero secret material appears in the journal.
     - Inject an oversized payload (>100KB) and assert it is safely truncated with `[TRUNCATED: original length ...]`.
   - **Narrative Render Verification**:
     - Query `timeline()` and run `narrateEntry()` on every span in the flow, asserting non-empty, descriptive narrative sentences.
2. **[MODIFY] [test/unit/tc_journal_narrate.test.ts](file:///d:/Dept%20of%20code%20v2/test/unit/tc_journal_narrate.test.ts)**
   - Add unit tests for every newly narrated span detail (verify runs, diff reviews, plan authoring, assignment details, etc.).

### B. Mutation Evidence to Record in `docs/mutation-evidence-phase8.md`
1. **M-JOURNAL-PROMPT**:
   - *Mutation*: Remove `prompt` from dispatch / authoring journal detail in `dispatch-job.ts` or `plan_review_cycle.ts`.
   - *Catching Test*: `tc_journal_completeness.test.ts` fails asserting verbatim prompt in journal.
2. **M-JOURNAL-VERIFY**:
   - *Mutation*: Omit stage breakdown and output excerpt from `verify.run` tool span detail in `verify/job.ts`.
   - *Catching Test*: `tc_journal_completeness.test.ts` fails asserting verify command/stages in journal.
3. **M-JOURNAL-SECRET**:
   - *Mutation*: Bypass `redactOutput` in `writer.ts`.
   - *Catching Test*: Secret scrub test in `tc_journal_completeness.test.ts` catches unredacted key.

---

## 4. Walkthrough / Verification Plan
1. **Run Full Test Suite**:
   - `npx vitest run` (ensure full suite green ×2).
   - `npm run build` (`tsc --noEmit` clean).
2. **Walkthrough Document**:
   - Generate a journal dump of the complete fake flow from `tc_journal_completeness.test.ts`.
   - Show timeline entries and full reconstruction of the pipeline story from the journal alone.
