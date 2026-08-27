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
  (14/14 across the two). `git diff` confirmed only the intended +21/+1 lines remained.

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
