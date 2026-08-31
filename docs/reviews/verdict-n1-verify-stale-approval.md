# Senior verdict — N1(b): verify success must not deliver on a stale approval

- **Branch:** `wt/n1-verify-sendback` (tip `1ad9042`)
- **Senior:** claude (Claude Code CLI, `claude -p`, static/close-read review)
- **Kind:** walkthrough (engine-dev diff review)
- **Date:** 2026-08-31
- **Rounds:** 2 — **round 1 REVISE** (confirmed self-match bug), **round 2 APPROVE**

## Round 1 — REVISE (senior-caught bug)
The senior confirmed a high-severity bug that defeated the fix's purpose: the
re-review idempotency guard checked
`kind IN ('work.cycle','worktree.prepare','verify.run')` from INSIDE the current
`verify.run` job's finalization transaction (before `completeJob`), so that job
self-matched — `work.cycle` was never enqueued and the task parked at `claimed`
with no live job, silently stranded. The round-1 unit test missed it because it
called `handleVerifyOutcome` in isolation with no real job row.

## Round 2 — APPROVE
Fix: narrowed the idempotency check to `kind = 'work.cycle'` only (the sole job
kind being enqueued), removing the self-match entirely. Added
`test/integration/tc_verify_stale_approval_flow.test.ts`, which drives the real
job-table state through `executeVerifyRunJob` on a real `GitWorkspaceProvider`
and asserts exactly one `work.cycle` is enqueued (mutation M-N1b: re-widening to
include `verify.run` fails it). Senior's trace confirmed:
- `handleVerifyOutcome` runs before `completeJob`, so the current `verify.run`
  row is non-terminal; narrowing to `work.cycle` removes it from the candidate
  set — the correct, minimal fix.
- `verifying → claimed` is legal for `verifier` (matches the sendback path).
- Schema columns, the `getBranchTipCommit` import (no cycle), and the
  `COUNT(*) n` style all check out.
- Agreed that checking only `work.cycle` is sufficient (prepare/verify.run are
  downstream of an approval, not re-review actions).
- Could not execute the suite (sandbox Bash blocked); reviewed by close reading.
  Honest nit: the flow test's job is `pending` (direct SELECT, not `claimJob`)
  rather than `running`, but the old guard matched both so it reproduces the
  regression exactly.

## Scope note
Only option (b) (the stale-verdict hole) is in this change. Option (a) — a real
junior verify-fix dispatch — is deferred behind N0 (see
`docs/plan-pre-phase8-remaining.md`). The retry/block budget (t25/t29) is
deliberately untouched.

## Verification
Suite 652/652 across 119 files, `tsc --noEmit` clean on the branch (re-run on
merged main by the implementing session — see ledger).
