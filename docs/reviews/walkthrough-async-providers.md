# Walkthrough — Flow-resilience fix pack, Stream 1: async subprocess providers + lease headroom

**Branch:** `wt/junior-b-async-providers` · **Tip:** `5c29391` · **Base:**
`main` = `d334004` · **Plan:** `docs/plan-flow-resilience-fixpack.md`
(untracked) · **Status:** NOT merged — awaiting senior verdict.

## The defect (evidence, live DB journal #790–#812)

Every external-world provider ran `execFileSync`: `GhCliPrProvider`
(`engine/delivery/gh_cli_pr_provider.ts`), `GhCliRepoProvider`
(`engine/projects/repo_provider.ts`), `ExecGitBackupProvider`
(`engine/durability/git_backup_provider.ts`). `gh pr create` takes ~6s live;
while it ran, the runner's event loop was FROZEN — the 1s heartbeat timer
could not fire, the 5s job lease (`BUREAU_LEASE_MS`) expired mid-flight, and
the second live runner (console background + standalone, by design) reaped
and re-claimed the job. Both runners then executed the same job: the
2026-08-28 journal shows claim (16:17:33.753, 5s lease) → reap (16:17:38.806)
→ re-claim by the other runner (16:17:38.830) → PR #3 created by runner 1
(16:17:39.761) → runner 2's duplicate `gh pr create` collides → zombie
retries "task is done (must be needs-review)" ×2 → dead-letter + 2 guardrail
spans. Same shape on PR #4 and PR #2. The fail-closed guards held (nothing
merged twice) — but every delivery raced duplicate execution.

## Changes

1. All three providers: `execFileSync` → promisified `execFile`. Error
   message shapes preserved (the journal/last_error strings are unchanged in
   form). While the loop is free, the heartbeat keeps the lease alive.
2. `BUREAU_LEASE_MS` default **5000 → 30000** (`runner/main.ts` config
   comment explains why 30s is headroom, not a target). A genuinely dead
   runner is still reaped within 30s + poll.

## Claims (re-runnable)

- Suite **587/587 ×2** on this branch; `npx tsc --noEmit` clean.
- New `tc_async_providers.test.ts` (3 tests):
  1. A 600ms async `backup.push` through a REAL `Runner` (lease 2000ms,
     heartbeat 25ms — production 30:1 ratio) survives a simulated
     second-runner reaper ticking every 250ms: job `done`, `reaped_count` 0,
     zero reaps, ≥12 loop ticks during the handler.
  2. Lease-default pin: `runnerConfigSchema.parse({}).BUREAU_LEASE_MS ===
     30000`.
  3. The REAL `ExecGitBackupProvider` over a REAL temp git repo yields the
     loop across five real `git rev-parse` subprocesses (≥6 ticks at 5ms;
     exactly 0 when synchronous).
- **M-ASYNC-1 (real, executed twice):** first as a naive reversion (caught
  by shape mismatch — recorded), then FAITHFULLY — same return shape but
  synchronous exec — caught by test 3 with **"expected 0 to be greater than
  or equal to 6"**: the frozen-loop detector, exactly the incident
  mechanism. Restored and re-verified.

## For the senior to re-run

`npx vitest run test/unit/tc_async_providers.test.ts` — then M-ASYNC-1:
replace the `execFileAsync` call body in `git_backup_provider.ts`
`runCommand` with a same-shape `execFileSync` and watch test 3 fail with
ticks = 0.

## Honest notes

- Test 1's first draft used a 200ms lease and WAS flaky under the full
  parallel suite (CPU starvation delays timers — the A4 wall-clock lesson);
  it now uses production-ratio margins (2000ms/25ms) and was stable across
  all full-suite runs. The deterministic sync-detection lives in test 3.
- During development the detector caught a REAL lapse: I had converted only
  two of the three providers when I first ran it — ticks = 0 on the
  unconverted backup provider. That failure is the test working, and is
  recorded here rather than hidden.
- `repo_provider.ts`'s async conversion ships here; Stream 2's branch
  carries an identical conversion of `git_backup_provider.ts` so both
  branches merge without conflict.
