# Walkthrough — Flow-resilience fix pack, Stream 2: backup truth after server-side PR merges

**Branch:** `wt/junior-a-backup-truth` · **Tip:** `294fe35` · **Base:**
`main` = `d334004` · **Plan:** `docs/plan-flow-resilience-fixpack.md`
(untracked) · **Status:** NOT merged — awaiting senior verdict.

## The defect (evidence, live DB)

`pr.merge` merges PRs **on GitHub** — `origin/main` advances while local
main stays behind. The chained `backup.push:<tip>` then ran
`git push origin main` from the local repo and died
`! [rejected] (fetch first)` on EVERY delivery: four dead `backup.push` jobs
across 2026-08-26→28 (e.g. journal #809/#814/#821 for `5d29e47b`). The
durability guarantee silently degraded to "the operator pushed by hand", and
local/origin diverged until a manual reconcile (the `40e4157` merge).

## Changes

1. `BackupProvider` gains **optional** `fetch` / `remoteContains` /
   `fastForwardLocal` (feature-detected by the handler; existing fakes and
   the legacy push path stay valid).
2. `ExecGitBackupProvider` implements them (async conversion identical to
   Stream 1's, so the branches merge cleanly); `runCommand` now PRESERVES
   the subprocess exit code on its wrapper error so
   `merge-base --is-ancestor` exit 1 reads as `false`, not failure.
3. `handleBackupPush` new order: **fetch** (best-effort, journaled warning)
   → **fast-forward local main** to the remote tracking ref (best-effort;
   divergence is never silently forced) → **containment proof**: if the
   remote already contains the payload `commit`, journal
   `status:'already_on_remote'` with the verified remote tip and FINISH —
   no push, no rejection → else the classic push + anti-false-claim
   readback (unchanged).
4. `pr_merge` threads `commit` (the tip) through the backup payload;
   registry schema updated.
5. `getBackupProvider()` default: explicit repo root derived from the
   engine tree — NOT `process.cwd()` (a stray cwd aimed every git command
   at the wrong repo).

## Claims (re-runnable)

- Suite **588/588 ×2** on this branch; `npx tsc --noEmit` clean.
- New `tc_backup_truth.test.ts` (4 tests) against REAL git repos and a REAL
  bare remote (temp paths, no network):
  1. Server-side merge shape: a second clone advances `origin/main`;
     handler records `already_on_remote` for the server tip AND local main
     is fast-forwarded to it (the divergence cure).
  2. `remoteContains` exit-code semantics: `false` for an unpushed local
     commit, `true` for the server tip (after fetch — the handler's
     contract).
  3. Local genuinely ahead: push + readback success span (the legacy case
     still works).
  4. A minimal push/getTips provider (no optional methods) still completes
     via the legacy path.
- **M-BT-1 (real, executed):** skip the containment branch (`if (false &&
  …)`) → test 1 fails ("expected {action:'backup.push',…} to match
  {status:'already_on_remote'}"). Restored, re-verified.

## For the senior to re-run

`npx vitest run test/unit/tc_backup_truth.test.ts test/unit/t48_backup_push.test.ts`
(t48 = the pre-existing mismatch/refusal coverage, still green) — then
M-BT-1 via the recorded edit.

## Honest notes

- When the remote is ahead and local has UNRELATED unpushed commits, the
  fast-forward honestly fails (journaled warning) and the push then fails
  fetch-first → dead-letter → operator reconcile. That case is real
  divergence and must not be silently resolved by a backup job.
- The already-remote path still does a `getRemoteTip` readback — the
  anti-false-claim rule extends to the no-push branch.
