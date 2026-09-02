# Senior verdict — N17: claim-time assignment + capacity queue

- **Branch:** `wt/flow-claim-assignment-queue` @ `9260730`
- **Against:** main `47ccd45`
- **Reviewer:** claude senior (Claude CLI subprocess, `claude-sonnet-4-5`, headless
  agentic — file reads + greps in this repo; genuine independent review, the
  implementer is a different model/session)
- **Kind:** phase-4 code-diff review of the full change (18 files, +1203/−101)
- **Date:** 2026-09-02
- **Plan:** `docs/plan-n17-claim-assignment-queue.md` · **Mutations:** M-N17a/b/c
  (`docs/mutation-evidence-phase8.md`)

## Verdict

**APPROVE** — zero findings across all ten review targets:

1. `ensureTaskAssignment` transactional idempotency correct; the concurrent-writer
   race resolves via the `WHERE assigned_junior IS NULL` CAS and returns the
   winner's pin — never overwrites.
2. `juniorIsOccupied` cannot deadlock: a failed cycle row goes `dead` and frees
   the junior; a claimed/verifying task legitimately holds its junior (its
   half-done work lives in that conversation — interleaving is the contamination
   we are preventing), with operator block/archive as the release path.
3. The capacity-defer reset cannot loop: the reset path writes the assignment
   pin, and the candidate query excludes assigned tasks — one-way exit.
4. Plan-cycle defer ordering verified: state → ceiling → assignment → agent
   work; a deferred cycle burns zero rounds and does zero agent work.
5. Dispatch pin resolution: no silent default on the agent-prompt path
   (assignment wins over conflicting payloads; unpinned refuses loud);
   non-prompt legacy paths deliberately keep the old window semantics.
6. Filing no longer enqueues `plan.cycle`; the runner-sweep contract holds
   (queue paused, not stranded, when no runner is up).
7. Done-gate + human-approval invariants untouched (no diff to machine/gate).
8. Mutations M-N17a/b/c judged honest and adversarial (each resurrects one of
   the 2026-09-02 failure modes; each caught by the named test).
9. N3/N11/N12/N16 test updates are fixture-only, no semantic drift.
10. Journaling complete: authoring prompts, review feedback, the `assignment`
    span at claim, lease-conflict dedupe.

Reviewer's own summary: *"The change enforces the operator's six-law contract
(claim-time pin, one-task-per-junior, FIFO queue, loud refusal,
same-conversation, full journal). No correctness, safety, or regression
findings. The 716/716 suite and three adversarial mutations prove the
implementation."*

## Evidence on the record

- Suite **716/716 ×2** across 128 files on the branch; `tsc --noEmit` clean.
- Mutations executed for real (mutate → named test fails → restore → green),
  recorded in `docs/mutation-evidence-phase8.md` §N17.
- Incident forensics (journal spans #1397–#2804) in
  `docs/plan-n17-claim-assignment-queue.md`.
