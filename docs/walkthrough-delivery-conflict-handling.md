# Walkthrough — Delivery-Conflict Handling (`wt/delivery-conflict-handling`)

**Date:** 2026-09-06 · **Implementer:** zai (ZCode/GLM-5.3), operator-session
engine-dev · **Plan:** `docs/plan-delivery-conflict-handling.md`
**Verification standard:** suite + build green on the branch, mutations
executed live, honest disclosure of every irregularity.

## What this delivers

Fixes the "only the first approved task merges" delivery failure, in the
scoped form agreed after the two-session verification (zai + Claude):

1. **PR 1 — conflict classification** (`engine/delivery/pr_merge.ts`):
   gh's deterministic "not mergeable" refusal is now a `PrRefusalError`
   (`PR_MERGE_NOT_MERGEABLE`, non-retryable → job dead on attempt 1, no more
   3× zombie retries) after a `delivery_conflict` guardrail span + operator
   notification + queueing the recovery job. Transient provider failures
   (network) remain retryable — only the deterministic class is terminal.
2. **PR 2 — hygiene**: `checkpoint()` stages with
   `git add -A -- ':(exclude)docs/junior-artifacts'` (repo-independent —
   covers non-dept projects too; own AND foreign artifacts stay on disk,
   untracked); `/docs/junior-artifacts/` added to `.gitignore`;
   `docs/mutation-evidence-phase*.md` gets the built-in `merge=union` driver
   via `.gitattributes` (append-only evidence auto-merges both-append).
   NO existing tracked record was untracked — that stays the operator's call.
3. **PR 3 — freshen-then-merge** (`engine/delivery/freshen.ts` new job
   `delivery.freshen`; `pr_create.ts` idempotency; registry + JOB_KINDS):
   fetch + merge `origin/<base>` in the task worktree; conflict → `git merge
   --abort` + mandatory pristine self-check (`FRESHEN_ABORT_UNCLEAN` if not)
   + conflict report naming files, task held at `needs-review`; clean →
   in-job re-verification via the SAME `runStagedVerifier` (recorded as a
   real `bureau_verify_runs` row) → exit 0 queues `work.diff-review` at the
   new tip (phase4 gate re-entered, never bypassed; its dedup applies) →
   APPROVE chains pr.create → pr.merge; exit ≠ 0 → `reverify_failed` report
   (semantic conflict), merge commit kept. Budget: 2 terminal freshen cycles
   per task, counted from job rows, exhaustion journaled + notified, no git
   work. `pr.create` with an existing `pull_request_url` pushes the tip and
   re-enqueues merge for the SAME PR (no "already exists" death).

## Non-destruction guardrails (joint-review requirements), each test-locked

- **No auto-resolution anywhere:** no `-X ours/-X theirs`, no rebase, no
  reset, no force-push in the handler. Conflict → abort → self-check →
  report. Guardrail test: `tc_delivery_freshen` "REAL conflict" asserts tip
  unchanged, porcelain empty, task's file content byte-identical.
- **Backup before touch:** C3's local-only branch
  `bureau-wt-a2a9112e-d89b-4de9-8010-b7a2ff3e47a7` was pushed to origin
  FIRST (remote `be38209` == local, verified) before any work began.
- **No destruction of committed records:** ignore new artifacts only;
  existing tracked files untouched (verified: `git ls-tree` counts unchanged).

## Honest framing (per the joint review)

The two corpses (PR #9 `05c6edc0`, PR #11 `9a5bfa98`) have genuine CODE
conflicts (`diff_review_cycle.ts`, `tc_antigravity.test.ts`,
`tc_resume_flow.test.ts`…). This pack does NOT auto-heal them — on redrive
they are expected to take the conflict path: an actionable block report with
the branch pristine, followed by human reconciliation. Auto-recovery applies
only to the trivially-freshenable case. A blocked corpse is not a success.

## Evidence

- **New tests (11):** `tc_delivery_freshen.test.ts` (6: conflict-abort,
  clean-freshen→reverify→review-queued, semantic-conflict, budget, off-gate,
  dirty-tree), `tc_delivery_hygiene.test.ts` (2: checkpoint exclusion,
  union-merge), `t44_pr_merge.test.ts` (+2: classification, other-failures-
  stay-retryable), `t43_pr_create.test.ts` (+1: idempotent re-delivery).
- **Mutations M-DC1..M-DC5:** executed live, each caught, output captured in
  `docs/mutation-evidence-phase8.md`. Disclosure: the first M-DC2 attempt was
  a NO-OP (the abort call was accidentally left in the "disabled" mutant and
  the test rightly passed); the mutation was redone properly and caught. The
  pristine-state self-check acted as the second catcher.
- **Suite:** two fully-green full runs **825/825 across 135 files** (18:15 and
  18:28; the 18:28 run exited 0). One intervening full run (18:26) hit a
  single failure in `test/unit/tc_agent_wait.test.ts` (N0 evidence-timeout
  timing under full-suite parallel load — the documented flake class; this
  branch does not touch `agent-wait.ts` or that test), green ×2 in isolation
  immediately after.
- **Build:** `tsc --noEmit` clean on the branch (two early type errors in the
  new test fixtures — `unknown` rows from the typed DB seam — were fixed;
  the first build check masked them behind a `tail` pipe, caught on re-run).
- **Live diagnosis record** (pre-fix, read-only on `db/bureau.db`): dead
  pr.merge ×3 for `1ac387ee`, `05c6edc0` (PR #9), `9a5bfa98` (PR #11) with
  gh's "not mergeable: the merge commit cannot be cleanly created" verbatim;
  task rows stranded needs-review/approved/exit-0; `git merge-tree` proof of
  the exact conflicting files per branch.

## Operator next steps (after senior review + merge + runner restart)

1. Redrive the corpses: enqueue `delivery.freshen` for `05c6edc0` and
   `9a5bfa98` (expect conflict reports + file lists), reconcile the code
   overlaps manually in the worktrees, then re-drive delivery.
2. Decide the untracking of the 76 already-committed artifact files
   (`git rm -r --cached docs/junior-artifacts` + commit) — deliberately not
   done here.
3. Follow-ups filed in the plan: PR 4 (cross-task delivery-tail
   serialization at claim time — the "A1 lock" does NOT exist, verified) and
   PR 5 (admission-time file-overlap detection between in-flight tasks).
