# Senior Verdict — Department Assets Tab + First-Run Fixes + Bounded Work-Review Loop

**Commit under review:** `05dd8fb542b64b238779cdb07547058fc9514da5`
**Branch:** `wt/junior-assets-tab` (cut from `main` at `3bb07d0`; 4 commits:
`874162a` assets tab, `5f1f5d8` first-run fixes, `146f427` run transcript,
`05dd8fb` work-review loop)
**Date:** 2026-08-24
**Verdict:** ✅ **APPROVE — merge to main** (one process defect remedied below)

## What was verified (independently, not trusted)

- **Suite + build, re-run by the Senior:** two full `npx vitest run`, both exit 0 —
  **340/340 across 81 files** — and `npm run build` (`tsc --noEmit`) clean.
  Matches the walkthrough claim exactly.
- **Done-gate untouched (the invariant):** `git diff main..branch` over
  `engine/state/machine.ts`, `engine/verify/`, `engine/filing/`, `engine/intake/`
  is EMPTY. Reaching `done` still requires verifier exit 0 + human approval.
  The new cycle's only state moves are `queued→claimed` (legal planning edge)
  and `→blocked` at the work-review ceiling.
- **Dead backup — the bug was real and is fixed.** Main's
  `engine/contract/backup-seam.ts` called `require('../durability/git_backup_provider.ts')`
  inside `getBackupProvider()` — `require` is undefined in an ES module, so every
  `backup.push` job died at call time. The branch replaces it with a top-level
  import; `tc_backup_seam` (2 tests) is a genuine regression proof.
- **Plan→work loop closed.** `finishApproveRound` now transitions
  `queued→claimed` (reason `plan_approved`) inside the same transaction as the
  dispatch insert — the "zombie in queued" the first real run exposed cannot
  recur; the implementation dispatch carries `chainWorkReview: true`, and
  `handleJuniorDispatch` enqueues `work.cycle` in the SAME transaction that
  marks the dispatch complete (nothing fire-and-forget). `work.cycle` is a
  registered job kind (`maxAttempts: 1`, 45-min timeout) with a zod schema.
- **Prompts are honest.** `buildImplementationPrompt` takes an
  `ImplementationBasis`; the ceiling path says "review-round ceiling reached
  with the senior's feedback still outstanding … you MUST address the final
  required changes" — never "APPROVED". `buildFixPrompt` states the revision
  round and required changes verbatim. Both pinned by tests.
- **Bounded work-review loop.** `runWorkReviewCycle` writes a real
  `bureau_work_reviews` row and increments `cycles` transactionally with the
  journal span (budgets stay columns); on REVISE under the ceiling it enqueues
  a fix dispatch to the SAME junior (`freshConversation: false`,
  `chainWorkReview: true`, senior identity carried) that re-chains the
  re-review; at the ceiling (`review:work_rounds_ceiling`, default 5, meta
  overridable, sanity-checked) the task is **blocked** and the operator
  notified — no runaway loop. No-walkthrough skips with a guardrail span
  without billing a senior.
- **Policy change reviewed and accepted:** at the PLAN ceiling the flow no
  longer blocks — it proceeds to implementation with the final feedback
  threaded, and the walkthrough review becomes the compensating gate. This is
  disclosed in the constants comment, the code, the notify-operator wording,
  and pinned by `tc_plan_cycle` "AMEND at the ceiling…". The plan history and
  amend verdicts stay on the record. Consistent with the department's
  "see the whole flow through" direction; ceiling also raised 3→7.
- **Assets tab.** `bureau_assets` table with CHECK on status; 4 endpoints all
  behind the fail-closed token check (`console/server.ts` — 401 + guardrail
  span before any routing); blank name/url → 400 VALIDATION_ERROR; parameterized
  SQL throughout; `updated_at` refreshed on update; journaled as
  human-operator acts; DTOs redacted. Tests `tc6_assets_api` (7) +
  `tCONSOLE_assets_render` (4) are behavioral, not smoke.
- **XSS guard.** `safeHref` whitelists `^https?://` and escapes for attribute
  context; anything else renders as inert text (`javascript:`/`data:` etc.).
- **Roster honesty fix** (`engine/models/seed.ts`): the junior is no longer
  assigned a Google callModel role — it is the Antigravity harness agent;
  only the intake officer is a real google role. Correct attribution.

## Mutation evidence — re-executed by the Senior

The branch ships recorded evidence (M-ASSET-1/2/3, M-HREF, M-LOOP, M-BACKUP,
M-WLOOP in `docs/mutation-evidence-console.md` / `-phase7.md`). The Senior
independently re-executed two representatives live:

- **M-HREF (re-executed):** dropping the `^https?://` scheme check from
  `safeHref` fails exactly the two named tests (`tCONSOLE_assets_render` "2b.
  URL scheme guard" and `tCONSOLE_b1_render` "9. safeHref") — 2 failed / 13
  passed. Restored → 15/15 green.
- **M-WLOOP (re-executed):** disabling the ceiling check
  (`if (false && roundsUsed >= ceiling)`) fails exactly
  `tc_work_cycle` "REVISE at the ceiling: stops looping — the task is BLOCKED"
  (1 failed / 5 passed; a runaway fix dispatch is enqueued instead). Restored →
  6/6 green.
- Restoration verified by empty `git diff`; affected files re-ran 21/21.

## Process defect (remedied, non-blocking)

The junior left its walkthrough artifact untracked in the working tree
(`docs/reviews/walkthrough-assets-tab.md`) instead of committing it on the
stream branch — a violation of "junior work is committed on the stream branch,
never left uncommitted". Remedied by the Senior: the walkthrough (content
verified to match what was reviewed) is committed alongside this verdict.

## Non-blocking notes (operator advisories)

- The harness junior still writes in its own IDE workspace, not a bureau
  worktree, so automatic `verify.run → needs-review` against the junior's
  branch remains a separate stream — correctly disclosed in the walkthrough.
- `junior.dispatch` timeout raised 120s → 30 min (GUI agents work for many
  minutes); matches the registry's live wiring. Reasonable, but a wedged GUI
  now occupies a runner slot for up to 30 min before surfacing.
- The plan-ceiling-proceeds policy means a task whose plan never converges
  still reaches implementation; quality is back-stopped by the work-review
  cycle (bounded, blocks at its own ceiling). If the operator prefers hard
  stops at the plan stage, flip the ceiling path back to `blocked` — it is a
  policy constant away, not a structural change.

All three bundled scopes do what the walkthrough claims, the invariant is
intact, and the evidence is real. **Approved for merge.**
