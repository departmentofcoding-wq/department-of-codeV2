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

---

## M-PROV-CONSOLE-1 — endpoint manifest freeze for POST /api/projects/provision

- **Guard:** `console/contract.ts` — `ENDPOINTS` manifest includes `{ method: 'POST', path: '/api/projects/provision', auth: 'token', ... }` (33 total endpoints).
- **Mutation:** `POST /api/projects/provision` removed from `ENDPOINTS` manifest array.
- **Catcher:** `test/unit/contract_d0_c.test.ts` → `Milestone D0-C — Console Contract Freeze > 2. Endpoint Manifest`:
  ```
  FAIL test/unit/contract_d0_c.test.ts > Milestone D0-C — Console Contract Freeze > 2. Endpoint Manifest: every endpoint declares method, path, description, and token auth
  AssertionError: expected 32 to be 33 // Object.is equality
  - Expected
  + Received
  - 33
  + 32
  ```
- **Restore:** endpoint restored to `ENDPOINTS` in `console/contract.ts`; test green (4/4).

---

## M-PROV-CONSOLE-2 — deterministic job ID generation for project provisioning

- **Guard:** `console/server.ts` — `const jobId = projectProvisionJobId(canonicalName);` computes deterministic job id `project.provision:<canonicalName>` for deduplication / idempotency.
- **Mutation:** replaced deterministic call with random UUID generation `const jobId = crypto.randomUUID();`.
- **Catcher:** `test/unit/tc7_projects_api.test.ts` → tests 7 and 8 (job id format and idempotency duplicate calls):
  ```
  FAIL test/unit/tc7_projects_api.test.ts > T-C7: Projects API (register + list git repos the bureau works in) > 7. POST /api/projects/provision: enqueues project.provision job with deterministic id, returns 202
  AssertionError: expected '895eb0a7-e185-4e91-a431-8eb8ab86cf71' to be 'project.provision:dept-my-new-app' // Object.is equality

  FAIL test/unit/tc7_projects_api.test.ts > T-C7: Projects API (register + list git repos the bureau works in) > 8. POST /api/projects/provision: Idempotency — duplicate calls return identical jobId without duplicating rows
  AssertionError: expected 'a8e1255c-88af-4568-b36a-21a7ac2370da' to be 'fda86904-44a3-43b5-9e94-2b86f3c68d1f' // Object.is equality
  ```
- **Restore:** `projectProvisionJobId(canonicalName)` restored; test suite green.

---

## M-PROV-CONSOLE-3 — input validation gate on project name

- **Guard:** `console/server.ts` — `if (!name)` checks for missing or whitespace-only name and returns 400 `VALIDATION_ERROR`.
- **Mutation:** bypassed validation gate with `const name = body.name?.trim() || 'default-fallback'; if (false)`.
- **Catcher:** `test/unit/tc7_projects_api.test.ts` → test 9 (Validation gate):
  ```
  FAIL test/unit/tc7_projects_api.test.ts > T-C7: Projects API (register + list git repos the bureau works in) > 9. POST /api/projects/provision: Validation — blank name returns 400 VALIDATION_ERROR
  AssertionError: expected 202 to be 400 // Object.is equality
  - Expected
  + Received
  - 400
  + 202
  ```
- **Restore:** validation gate restored in `console/server.ts`; test suite green.

---

## M-PROV-CONSOLE-4 — masked GitHub connection status via getRepoProvider()

- **Guard:** `console/server.ts` — `GET /api/settings/github` queries `await getRepoProvider().getAuthStatus()`.
- **Mutation:** replaced live provider status call with hardcoded disconnected empty object `{ authenticated: false, login: null, scopes: [] }`.
- **Catcher:** `test/unit/tc7_projects_api.test.ts` → test 12:
  ```
  FAIL test/unit/tc7_projects_api.test.ts > T-C7: Projects API (register + list git repos the bureau works in) > 12. GET /api/settings/github: returns masked shape composed from fake provider + DB config
  AssertionError: expected false to be true // Object.is equality
  - Expected
  + Received
  - true
  + false
  ```
- **Restore:** provider call restored in `console/server.ts`; test suite green.

---

## M-PROV-CONSOLE-5 — provisioning status chip CSS state rendering

- **Guard:** `console/public/render.js` — `renderProvisioningChip` assigns state class (`chip-provisioning`, `chip-done`, `chip-failed`).
- **Mutation:** omitted `statusClass` from returned element `class="provisioning-chip"`.
- **Catcher:** `test/unit/tCONSOLE_projects_render.test.ts` → test 4:
  ```
  FAIL test/unit/tCONSOLE_projects_render.test.ts > T-CONSOLE: Projects Render Core > 4. renderProvisioningChip: renders pending, done, and failed states
  AssertionError: expected '\n    <div class="provisioning-chip" …' to contain 'chip-provisioning'
  - Expected
  + Received
  - chip-provisioning
  +
       <div class="provisioning-chip" data-job-id="job-1">
         <span class="chip-label">⏳ Provisioning my-app...</span>
       </div>
  ```
- **Restore:** `statusClass` restored in `console/public/render.js`; test suite green.

Executed 2026-08-27 on branch `bureau-wt-1429a7de-1bb0-4daf-8d4a-84850997eb26` by the implementing session;
all 5 mutations reproduced → restored → re-verified in one sitting, failure output
captured verbatim from `npx vitest run`.


---

## M-N8 — pr.create/pr.merge run `gh` in the dept repo for non-dept projects

- **Guard:** `engine/delivery/pr_create.ts` threads the task worktree path into
  `prProvider.createPr(input, wtRow?.path)` (and `pr_merge.ts` into
  `mergePr(prNumber, wtRow?.path)`), so `gh` runs in the task's own project repo
  — mirroring what `pushBranch` already did. The `PrProvider` seam gained the
  optional `cwd` param on both methods; `GhCliPrProvider` forwards it to
  `runCommand`.
- **Mutation:** dropped the `cwd` argument from the `createPr` call site
  (`}, wtRow?.path);` → `});`), reproducing the pre-fix behaviour where `gh pr
  create` executed in the dept repo's cwd (the 2026-08-31 N8 delivery failure:
  *"No commits between main and bureau-wt-…"* for every non-dept project).
- **Catcher:** `test/integration/t43_pr_create.test.ts` → happy path:
  ```
  FAIL test/integration/t43_pr_create.test.ts > T43: pr.create Job Integration Test > happy path: …
  AssertionError: expected undefined to be 'C:\Users\adith\AppData\Local\Temp\bur…' // Object.is equality
    115|     expect(fakePrProvider.createCwds[0]).toBe(handle.path);
  ```
  `t44_pr_merge.test.ts` happy path asserts the symmetric `mergeCwds[0]`.
- **Restore:** call site restored; full suite 646/646 across 117 files, `tsc
  --noEmit` clean.

Executed 2026-08-31 on branch `wt/n8-pr-gh-project-cwd`; mutation reproduced →
restored → re-verified, failure output captured verbatim from `npx vitest run`.

---

## M-N1 — verify success delivers on a stale standing approval

- **Guard:** `engine/verify/loop.ts` `handleVerifyOutcome` success path — before
  transitioning to `needs-review`, if the latest approved `bureau_work_reviews`
  row has a non-null `reviewed_commit != tip` (a `verify-failure-sendback`
  checkpoint moved the branch tip past the approved commit), it re-enters senior
  review instead: transition `verifying -> claimed`, enqueue `work.cycle`
  (idempotent), journal a `verify_passed_stale_approval` guardrail, notify the
  operator. `tip` is read in `engine/verify/job.ts` before the finalization txn
  (best-effort; undefined disables the guard, preserving fake-provider tests).
- **Mutation:** disabled the guard predicate (`if (approval && … !== opts.tip)`
  → `if (false && …)`), reproducing the pre-fix behaviour where a passing verify
  lands at `needs-review` while the standing approval points at the old commit
  (the b55e2fda scar: `pr.create` then refuses on `reviewed_commit != tip` and
  the task strands looking delivery-ready).
- **Catcher:** `test/unit/tc_verify_stale_approval.test.ts`:
  ```
  FAIL test/unit/tc_verify_stale_approval.test.ts > N1: … > stale approval …
  AssertionError: expected 'needs-review' to be 'claimed' // Object.is equality
  ```
  (2 of 5 tests fail: the stale-approval re-entry and the idempotency case.)

### M-N1b — self-match: the re-review is never enqueued (senior-caught)
The claude senior REVISE round caught that the idempotency guard first checked
`kind IN ('work.cycle','worktree.prepare','verify.run')` — but it runs INSIDE the
current verify.run job's transaction (before `completeJob`), so that job self-
matched and `work.cycle` was NEVER enqueued: the task parked at `claimed` with no
live job, silently stranded. Fixed by narrowing the check to `kind = 'work.cycle'`
only (the sole thing being enqueued), removing the self-match entirely.
- **Mutation:** re-widen the check to include `'verify.run'`.
- **Catcher:** `test/integration/tc_verify_stale_approval_flow.test.ts` (drives the
  REAL job-table state through `executeVerifyRunJob`):
  ```
  FAIL … > lands at claimed and enqueues work.cycle despite the running verify.run job
  AssertionError: expected +0 to be 1 // Object.is equality  (workCycle.length)
  ```
- **Restore:** narrowed check restored; full suite 652/652 across 119 files, `tsc
  --noEmit` clean. Preserved: t25/t29 exit-sentence loops (no work review → no
  trigger), t45 delivery tail (reviewed_commit == tip → needs-review).

Executed 2026-08-31 on branch `wt/n1-verify-sendback`; both mutations reproduced →
restored → re-verified, failure output captured verbatim from `npx vitest run`.
The self-match bug (M-N1b) was found by the claude senior review, not the initial
unit test — the reason the delivery flow keeps a senior in the loop.
