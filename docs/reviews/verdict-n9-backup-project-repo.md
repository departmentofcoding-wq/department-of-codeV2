# Senior verdict — N9: back up non-dept tasks against their own project repo

- **Branch:** `wt/n9-backup-project-repo` (tip `99f2210`)
- **Senior:** claude (Claude Code CLI, `claude -p`, static/close-read review —
  Bash test execution not granted, so verified by reading the checked-out files
  at `99f2210` + schema, not just the diff)
- **Kind:** walkthrough (engine-dev diff review)
- **Date:** 2026-08-31
- **Verdict:** **APPROVE**
- **Origin:** this finding was surfaced by the same claude senior during the N8
  review.

## What was reviewed
`getBackupProvider(repoRoot?)` roots the `ExecGitBackupProvider` at a caller
repo (default: the dept source tree). `backup_push.ts` resolves the task's
`bureau_projects.path_to_repo` (via `task.project_id`) and passes it, so a
non-dept task's fetch / ff-only / containment-check / push run against that
project's repo + remote. Dept tasks (project_id null) fall back to the default.

## Senior's findings (verbatim summary)
- Diff matches the real files; `bureau_projects.path_to_repo` /
  `bureau_tasks.project_id` are real columns with the assumed names/nullability.
- `getBackupProvider` has exactly one production call site, so nothing else was
  left targeting the wrong repo.
- The `task → project_id → path_to_repo` idiom is the **same pattern already used
  by `getTaskRepoRoot` in `engine/worktrees/manager.ts`** — strong independent
  confirmation of the right source of truth.
- Back-compat is concretely provable: `t48_backup_push.test.ts` seeds
  `project_id = NULL` and sets an override before `handleBackupPush`, so the new
  lookup is inert there regardless.
- New test DB inserts are schema-valid; the journal assertion matches the real
  writer; `vi.spyOn` on the named import is a legitimate Vitest ESM technique.
- The honesty note (earlier draft's mutation touched the live dept repo, then
  redesigned to spy so it's structurally impossible now) reads as good judgment.
- Could not re-run the 654/654 suite (sandbox Bash not granted).

## Non-blocking follow-up (recorded, not applied)
`backup_push.ts` reimplements the task→project→repo lookup inline instead of
calling the existing `getTaskRepoRoot` helper. Not a bug — `getTaskRepoRoot`
requires an explicit fallback root, while `backup-seam.ts`'s default is computed
lazily from `import.meta.dirname`, so reuse isn't quite free. Worth a follow-up
simplification pass; left out of this approved diff to avoid re-opening review.

## Verification
Suite 654/654 across 120 files, `tsc --noEmit` clean on the branch (re-run on
merged main by the implementing session — see ledger).
