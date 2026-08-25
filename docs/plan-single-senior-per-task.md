# Plan — one senior per task (no two seniors reviewing the same code)

**Status:** proposal (not yet implemented). Author: operator stream, 2026-08-25.
**Goal:** exactly ONE senior owns a task's reviews end-to-end; no piece of work is reviewed by more than one senior; no out-of-band reviewer duplicates the dept's assigned senior.

## The problem — two ways a second senior reads the same code

1. **Out-of-band peer reviewer (the acute one).** A peer Claude session has been acting as an uncontrolled second Senior/Operator — reviewing branches and hand-merging — on top of the dept's own assigned senior. That is two seniors reviewing the same work, and it's outside the tracked flow. **Addressed already:** the peer session was told to stand down (2026-08-25), and AGENTS.md + the DEPARTMENT_STATUS scars now forbid out-of-band review/merge. This plan assumes reviews run only through the dept.

2. **Structural: assignment is per-artifact-kind, not per-task.** `assignSenior({kind})` sends **plans → claude** and **walkthroughs → zai** (see `engine/harness/senior.ts`). For a single task that means *both* seniors are pulled in across its lifecycle — the plan senior (claude) and the walkthrough senior (zai) each build up context on the same task independently. It's not the same *artifact* reviewed twice, but it is two seniors reading the same task's code/plan, which wastes context, time, and quota — and it defeats the round-reuse win (a senior that reviewed the plan already holds context that the walkthrough review throws away when it goes to the other senior).

There is also a latent third source: the legacy `senior.review-plan` / `senior.review-work` jobs (`engine/review/*`) still exist alongside the harness cycles (`engine/flow/plan_review_cycle.ts`, `work_review_cycle.ts`). If both paths ever fire for one task, that's a double review.

## Design

### 1. Single-reviewer-per-TASK assignment
Replace per-kind assignment with a deterministic per-task one:

```
assignSeniorForTask(taskId): 'claude' | 'zai'
  = SENIOR_DEFAULT override, else a stable hash(taskId) % seniors  // spreads load across tasks
```

- The **same** senior reviews that task's plan AND its walkthrough → one context holder for the whole task, no second senior on the same code.
- Load still spreads **across** tasks (task A → claude, task B → zai, …), so both seniors stay busy — parallelism is preserved, duplication is removed.
- Keep `SENIOR_PLAN` / `SENIOR_WALKTHROUGH` / `SENIOR_DEFAULT` env overrides for manual pinning, but the default becomes task-scoped, not kind-scoped.
- Pairs with the shipped conversation-reuse change: same senior + same conversation across a task's rounds = maximal context reuse.

### 2. Review dedup / idempotency
Key each review to `(taskId, artifact-kind, round or reviewed_commit)`. Before invoking a senior, check whether a review row already exists for that exact artifact; if so, skip (no second senior, no re-billing). This makes a re-triggered `plan.cycle`/`work.cycle` job safe.

### 3. One review path
Pick the harness cycles as the single review path; make the legacy `senior.review-plan` / `senior.review-work` jobs no-ops (or remove their registrations) so a task can never be reviewed by both the legacy internal-`callModel` path and the harness senior. Document the decision in the ledger.

### 4. No out-of-band reviewers (enforcement)
Longer term, a review should be a `bureau_jobs` row driven by the runner (already true for the cycles), so no human/peer session ever hand-reviews. The AGENTS.md rule + peer stand-down cover this until enforced structurally.

## Work items
- `engine/harness/senior.ts`: add `assignSeniorForTask(taskId)`; keep `assignSenior({kind})` as a thin wrapper for the CLI/manual path.
- `engine/flow/plan_review_cycle.ts` + `work_review_cycle.ts`: use `assignSeniorForTask(task.id)` instead of `assignSenior({kind})`.
- Add the review-exists guard in both cycles.
- Retire/guard the legacy review jobs.
- Tests: deterministic assignment; same senior for a task's plan+walkthrough; different tasks spread across seniors; dedup skips a second review of the same artifact; env override still wins.

## Non-goals
- The done-gate is untouched (verifier exit 0 + human approval stays absolute).
- Does not implement workspace/worktree reconciliation (separate stream) — but single-senior-per-task is complementary to it.
