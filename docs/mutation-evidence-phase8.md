# Mutation Evidence — Phase 8

Format (unchanged since Phase 1): a mutation means the real code was edited,
a real test run observed the failure, the edit was reverted, and the suite went
green again. Guard → mutation → catcher test → failure output → restore.

---

## M-AGENTFILE-1 — the autofile flag gate (fail-closed opt-in)

- **Guard:** `engine/filing/agent_file.ts` step 2 — `if (!isAgentAutofileEnabled(db))`
  refuses with `AgentFileError('autofile_disabled')` + a `guardrail` journal span.
  This is what keeps the agent task-filing door safe-by-default: nothing files
  until the operator sets `bureau_meta['intake:agent_autofile'] = 'true'`.
- **Mutation:** flag gate flipped to always-pass — `if (!isAgentAutofileEnabled(db))` → `if (false)`.
- **Catchers:**
  - `test/unit/tc_agent_file_task.test.ts` → `T-AGENTFILE-2` (flag OFF refuses,
    zero task rows, guardrail span):
    ```
    FAIL test/unit/tc_agent_file_task.test.ts > T-AGENTFILE-2: Flag OFF (default) refuses
      with zero task rows and a guardrail span (M-AGENTFILE-1)
    AssertionError: expected undefined to be an instance of AgentFileError
    Tests  1 failed | 7 passed (8)
    ```
    (The call returned a filed task instead of throwing — the refusal vanished.)
  - `test/unit/tc_tasks_file_api.test.ts` → test 2 (endpoint 403):
    ```
    FAIL ... 2. Flag OFF (default): typed 403 autofile_disabled, zero tasks ...
    AssertionError: expected 201 to be 403 // Object.is equality
    Tests  1 failed | 5 passed (6)
    ```
- **Restore:** gate reverted to `if (!isAgentAutofileEnabled(db))`; both files green
  (17/17 across the tc_tail_fixes suite). `git diff` confirmed only the intended +21/+1 lines remained.

## M-AGENTFILE-2 — the actor allowlist

- **Guard:** `engine/contract/constants.ts` — `AGENT_FILE_ACTOR_ROLES = ['senior-engineer','human-operator']`,
  enforced in `fileAgentTask` step 1 (refusal code `actor_not_allowed` + guardrail
  span). A NEW array sibling to `PROVISION_ACTOR_ROLES`; the frozen `ACTOR_ROLES`
  vocabulary is untouched.
- **Mutation:** allowlist widened — `'junior-engineer'` prepended to the array.
- **Catcher:** `test/unit/tc_agent_file_task.test.ts` → `T-AGENTFILE-3`
  (junior-engineer attribution refused + journaled):
  ```
  FAIL test/unit/tc_agent_file_task.test.ts > T-AGENTFILE-3: Disallowed actor role
    (junior-engineer) is refused + journaled (M-AGENTFILE-2)
  AssertionError: expected undefined to be an instance of AgentFileError
  Tests  1 failed | 7 passed (8)
  ```
  (The junior's filing succeeded instead of being refused — exactly the widened
  door the mutation opened.)
- **Restore:** `'junior-engineer'` removed from the array; suite green again.

Executed 2026-08-27 on branch `wt/agent-task-door` by the implementing session;
both mutations reproduced → restored → re-verified in one sitting, failure output
captured verbatim from `npx vitest run`.

---

## M-TAIL-1 — provider-free reviewed_commit recording (F2)

- **Guard:** `engine/flow/work_review_cycle.ts` — `if (wtRow)` records `reviewed_commit`
  whenever a `bureau_worktrees` row exists, reading the worktree path from the DB
  provider-free via `getBranchTipCommit(db, task.id)`.
- **Mutation:** restored the old `if (wsProvider)` check around tip recording so
  that provider-less execution leaves `reviewed_commit` as `null`.
- **Catcher:** `test/unit/tc_tail_fixes.test.ts` → `records reviewed_commit on APPROVE when worktree row exists even without workspace provider`:
  ```
  FAIL test/unit/tc_tail_fixes.test.ts > Phase 8 Entry Fix Pack (F1-F6): Delivery-Tail Drill Scar Fixes > F2: Record reviewed_commit when worktree row exists (provider-free) > records reviewed_commit on APPROVE when worktree row exists even without workspace provider
  AssertionError: expected null to be '05bf2b1ea3a410c801036263a1ffd830cdb13…' // Object.is equality

  - Expected: 
  "05bf2b1ea3a410c801036263a1ffd830cdb1313c"

  + Received: 
  null
  ```
  (The review row's `reviewed_commit` remained null because `wsProvider` was null.)
- **Restore:** gate restored to `if (wtRow)` (provider-free); test suite green (17/17).

---

## M-TAIL-2 — one-branch refspec push in pr.create (F3)

- **Guard:** `engine/delivery/pr_create.ts` — `await prProvider.pushBranch(refspec, wtRow?.path)`
  where `refspec = 'HEAD:refs/heads/' + branchName`. Pushes the worktree's actual checked-out HEAD
  directly to the remote ref without relying on local branch name match.
- **Mutation:** reverted to pushing literal branch name: `await prProvider.pushBranch(branchName, wtRow?.path)`.
- **Catcher:** `test/unit/tc_tail_fixes.test.ts` → `pr_create pushes HEAD:refs/heads/bureau-wt-<taskId> refspec`:
  ```
  FAIL test/unit/tc_tail_fixes.test.ts > Phase 8 Entry Fix Pack (F1-F6): Delivery-Tail Drill Scar Fixes > F3: One-branch model (prompts + pr_create refspec) > pr_create pushes HEAD:refs/heads/bureau-wt-<taskId> refspec
  AssertionError: expected [ 'bureau-wt-task-f3-pr' ] to include 'HEAD:refs/heads/bureau-wt-task-f3-pr'
  ```
  (The provider pushed the literal branch name rather than the refspec.)
- **Restore:** push restored to `refspec`; test suite green (17/17).

Executed 2026-08-27 on branch `bureau-wt-e156395d-369f-494c-8237-ea1be5ee1aa8` by the implementing session;
both mutations reproduced → restored → re-verified in one sitting, failure output
captured verbatim from `npx vitest run`.
