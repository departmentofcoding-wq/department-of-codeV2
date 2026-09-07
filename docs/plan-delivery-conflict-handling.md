# Plan — Delivery-Conflict Handling (freshen-then-merge)

**Branch:** `wt/delivery-conflict-handling` · **Filed:** 2026-09-06
**Status:** implemented; awaiting senior review + operator merge
**Predecessors:** this fixes the delivery half of the finding the operator
brought 2026-09-06 ("only the first approved task merges"), independently
verified by two sessions (zai + Claude) against the code, the live DB, and
real git state.

## 1. Diagnosis (verified)

Delivery never updates a task branch onto the moving main. `pr_create.ts`
pushes `HEAD:refs/heads/bureau-wt-<taskId>` as-is; `gh_cli_pr_provider.ts`
merges with `gh pr merge N --merge`. No rebase / update-branch / merge-main
step exists anywhere in `engine/`.

Consequences, with live evidence (2026-09-06):

- **Three tasks have died this exact death.** `bureau_jobs` shows dead
  `pr.merge` rows ×3 attempts each for `1ac387ee` (N15, 2026-09-02, repaired
  manually), `05c6edc0` (PR #9), and `9a5bfa98` (PR #11 — C2, already dead,
  not merely "at risk"). gh's own error text names the missing step
  ("gh pr checkout 9 && git fetch origin main && git merge origin/main").
- **The failure is retried as if transient.** `pr_merge.ts` threw a plain
  retryable `DeliveryError` for provider failures; a conflict is
  deterministic, so 3 identical attempts burn and the job dies with the task
  stranded at `needs-review` and no recovery path.
- **Conflict amplifiers:** `checkpoint()` ran `git add -A`, committing
  `docs/junior-artifacts/**` (including FOREIGN dispatch ids — proven on
  branch `bureau-wt-05c6edc0`) onto delivery branches; and
  `docs/mutation-evidence-phase8.md` is a single append-only file every task
  appends to, so any two successive delivery branches conflict there by
  construction (one of PR #9's three conflicts).
- Exact conflict surfaces at diagnosis: PR #9 → `diff_review_cycle.ts`,
  `tc_antigravity.test.ts`, `mutation-evidence-phase8.md`; C2 →
  `tc_resume_flow.test.ts`; C3 (`a2a9112e`) → `tc_resume_flow.test.ts`
  (C3 was held at `amend`, not yet at the wall). `3c8e4a65` is a separate
  blocked case (empty branch, never approved).

## 2. Scope decision (from the joint review)

The corpses have genuine **code** conflicts — no automated freshen can or
should auto-merge conflicting source. So the honest framing of this fix pack:

> **Stop the silent zombie stranding; hand real conflicts to a human with an
> actionable report; auto-recover only the trivially-freshenable case.**

Deliberately NOT in this pack (filed as follow-ups):

- **PR 4 — cross-task delivery-tail serialization** (claim-time rule: at most
  one pr.create/pr.merge/delivery.freshen running across all tasks). Note:
  the earlier belief that an "A1 delivery-tail lock" exists was wrong — only
  a per-task enqueue dedup exists.
- **PR 5 — admission-time file-overlap detection** (warn/serialize when two
  in-flight tasks' planned files intersect) — the recurrence prevention.
- Untracking the 76 already-committed artifact files (`git rm --cached`) —
  explicitly the operator's call; this pack only stops NEW artifacts from
  riding branches.

## 3. The three non-destruction guardrails (joint-review requirement)

1. **Freshen never auto-resolves.** No `-X ours/-X theirs`, no rebase, no
   `reset`, no force-push. Conflict → `git merge --abort` → mandatory
   self-check (tip unchanged + porcelain empty, else `FRESHEN_ABORT_UNCLEAN`
   loud refusal) → report. Tested by `tc_delivery_freshen` "REAL conflict".
2. **Backup before touch.** C3's branch (`bureau-wt-a2a9112e`, junior work
   local-only) was pushed to origin (`be38209`) BEFORE any of this work.
   05c6/C2 were already on origin.
3. **No destruction of the committed dept record.** New artifacts are ignored
   and never swept onto branches; existing tracked records are untouched.

## 4. What was implemented

- **PR 1 — classify the conflict** (`engine/delivery/pr_merge.ts`):
  `NOT_MERGEABLE_RE` on the provider failure → `PrRefusalError`
  (`PR_MERGE_NOT_MERGEABLE`, non-retryable → dead on attempt 1) after
  journaling a `delivery_conflict` span, notifying the operator, and queueing
  `delivery.freshen`. Other provider failures stay retryable.
- **PR 2 — hygiene** (`.gitignore`, `.gitattributes`, `checkpoint.ts`):
  ignore `docs/junior-artifacts/`; `checkpoint()` stages with an explicit
  `:(exclude)docs/junior-artifacts` pathspec (repo-independent, so non-dept
  projects are covered too); `docs/mutation-evidence-phase*.md` gets the
  built-in `merge=union` driver (append-only evidence auto-merges
  both-append). No untracking of existing records.
- **PR 3 — freshen-then-merge** (`engine/delivery/freshen.ts` NEW,
  `pr_create.ts`, `registry.ts`, `constants.ts`):
  - `delivery.freshen` job: needs-review + clean-tree + worktree preconditions;
    `git fetch origin <base>` + `git merge origin/<base> --no-edit` in the
    task worktree (async — the 2026-08-28 freeze lesson).
  - Conflict → abort + self-check + `conflict` span with the file list +
    notify; task stays at `needs-review` (the N15 manual repair held the same
    line; `needs-review → blocked` is illegal under the TRANSITIONS law and
    `blocked → claimed` would be the wrong recovery for finished work).
  - Clean → re-verify in-job with the SAME `runStagedVerifier` (a clean
    textual merge can still break tests — semantic conflicts are conflicts),
    recorded as a real `bureau_verify_runs` row; exit != 0 → `reverify_failed`
    span + notify, merge commit kept (rollback would need a forbidden reset).
  - Exit 0 → enqueue `work.diff-review` (records the phase4 gate at the NEW
    tip; its existing dedup skips the senior only when an approved review
    already stands at exactly that tip) → APPROVE chains `pr.create` →
    `pr.merge` through the existing path. Delivery gates are re-entered,
    never bypassed.
  - Budget: `FRESHEN_CYCLE_BUDGET = 2` terminal prior freshen jobs (the job
    rows ARE the budget record) → `budget_exhausted` + notify, no git work.
  - `pr.create` idempotency: an existing `pull_request_url` skips
    `gh pr create` ("already exists" would kill a redrive), pushes the tip,
    and re-enqueues the merge for the SAME PR number.
  - Registry: `delivery.freshen` registered (maxAttempts 3, timeoutMs 10 min
    — it embeds a full staged verify); `delivery.freshen` and the previously
    missing `work.diff-review` added to `JOB_KINDS`.

## 5. Redrive of the two corpses (operator-gated, after merge + runner restart)

Both `05c6edc0` (PR #9) and `9a5bfa98` (PR #11) are expected to take the
CONFLICT path (their blockers are code files) — an honest block report with
the file list, branch pristine. A human then reconciles the overlapping edits
in the worktree (merge main, resolve, commit) and re-drives by enqueuing
`work.diff-review` (or one more freshen: up-to-date → reverify → dedup-skip
review → idempotent pr.create → pr.merge). A blocked corpse is NOT a success
and must not be reported as one.

## 6. Tests + evidence

- New `test/integration/tc_delivery_freshen.test.ts` (6 tests): conflict
  abort-pristine, clean freshen → reverify → review queued, semantic-conflict
  (failing verify) reported, budget exhaustion, off-gate refusal, dirty-tree
  refusal.
- New `test/integration/tc_delivery_hygiene.test.ts` (2 tests): checkpoint
  exclusion (own + foreign artifacts), union-merge auto-resolution.
- Extended `t44_pr_merge.test.ts` (+2): not-mergeable classification
  (non-retryable, freshen queued, delivery_conflict span, task held) and
  other-failures-stay-retryable. Extended `t43_pr_create.test.ts` (+1):
  idempotent re-delivery.
- Mutations M-DC1..M-DC5 in `docs/mutation-evidence-phase8.md` (one no-op
  mutation disclosed). Suite ×2 + `tsc --noEmit` clean on the branch.
