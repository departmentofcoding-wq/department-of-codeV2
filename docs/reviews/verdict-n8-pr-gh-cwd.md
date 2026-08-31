# Senior verdict — N8: pr.create/pr.merge run `gh` in the task's own repo

- **Branch:** `wt/n8-pr-gh-project-cwd` (tip `63160dc`)
- **Senior:** claude (Claude Code CLI, `claude -p`, static/close-read review — the
  `claude -p` sandbox's Bash test-run was permission-blocked, so the senior read
  every touched file directly rather than trusting the diff text)
- **Kind:** walkthrough (engine-dev diff review)
- **Date:** 2026-08-31
- **Verdict:** **APPROVE**

## What was reviewed
The N8 fix: `PrProvider.createPr`/`mergePr` gain an optional `cwd`;
`GhCliPrProvider` forwards it to `runCommand` (which already defaults
`cwd ?? this.repoRoot`); `pr_create.ts` threads `wtRow?.path` into `createPr`
(mirroring the existing `pushBranch`), and `pr_merge.ts` looks up the worktree
(still present pre-prune) and threads it into `mergePr`. `FakePrProvider` records
`pushCwds`/`createCwds`/`mergeCwds`; t43/t44 assert the real worktree path flows
through. Mutation M-N8 recorded.

## Senior's findings (verbatim summary)
- Back-compat is real, not just claimed: `runCommand` defaults
  `cwd: cwd ?? this.repoRoot`, so undefined → dept repoRoot (dept-repo tasks
  unchanged).
- `pr_create.ts` looks up `wtRow` once and threads it into both `pushBranch` and
  `createPr`; `pr_merge.ts` adds the same
  `bureau_worktrees WHERE task_id=? AND status<>'removed'` lookup (the pattern
  already used in `getBranchTipCommit`/`prune.ts`/`commit.ts`/`work_review_cycle.ts`)
  and threads it before the post-merge prune — worktree guaranteed present.
- t43/t44 assertions on `handle.path` (the real `GitWorkspaceProvider.prepare`
  path) are meaningful, not tautologies.
- Idempotent-re-merge concern checks out: a retry after `done` refuses at the
  precondition transaction (`task.state !== 'needs-review'`) before reaching the
  `wtRow` lookup or `mergePr`.
- Could not execute the suite (sandbox Bash blocked); the 646/646 + mutation
  claims are not independently re-run, but nothing in the code contradicts them.

## Out-of-scope observation (NOT a blocker) → new finding
`engine/durability/git_backup_provider.ts` / `backup_push.ts` always run in
`this.repoRoot` (the dept repo) with no cwd threading, and `pr_merge.ts`
unconditionally enqueues a `backup.push` after **every** merge (non-dept tasks
included) — so that job's containment-check/push runs against the **dept** repo's
`origin/main`, not the task's project repo. Pre-existing, untouched by this diff,
same class of bug as N8. Filed as **N9** in `docs/plan-pre-phase8-remaining.md`.

## Independent operator verification
Suite re-run on the merge commit by the implementing session (see ledger):
646/646 across 117 files, `tsc --noEmit` clean.
