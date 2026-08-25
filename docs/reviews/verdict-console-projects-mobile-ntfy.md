# Senior Verdict — Console Projects tab + mobile-responsive UI + ntfy expansion

**Verdict: APPROVE**
**Senior:** claude (Claude CLI, `claude -p`, review-only, fail-closed parse)
**Reviewed range:** `main` (`0ca54f6`) → tip `8ba7563` on `wt/console-projects-mobile`
**Walkthrough:** `docs/reviews/walkthrough-console-projects-mobile-ntfy.md`
**Date:** 2026-08-25

## Review path
The department's default walkthrough reviewer (zai / ZCode GLM, live on CDP 9335)
was attempted FIRST but **failed loudly** on a Send-control selector mismatch
(ZCode upgraded to 3.8.1, newer than the 9335 calibration) — the phantom-verdict
guard (`detectUncapturedReview` / submit-verification in `ZCodeSession.sendPrompt`)
correctly refused to record a verdict against uncaptured output rather than
fabricate one. Recalibrating the ZCode Send selector is filed as separate harness
work. The review then ran on the `claude` CLI senior (a sanctioned reviewer),
which has read access to the working tree and inspected the diff directly.

## Verdict text (verbatim)

> **VERDICT: APPROVE**
>
> The walkthrough's claims check out against the actual diff, line by line:
>
> - **Projects tab**: `GET/POST /api/projects` in `console/server.ts` reuse
>   `engine/projects/manager.ts` unchanged (confirmed via `git diff main..HEAD --
>   engine/projects/` — empty). Verified the gate directly: folder-existence
>   check, `isGitRepo`, `.bureau-worktrees/` gitignore append, and
>   `project-registered` journal span all present exactly as described. Frontend
>   table (`renderProjectsTable`) uses `escapeHtml` on every field. All `/api/**`
>   routes are token-guarded by one global check, so the "auth fail-closed" claim
>   holds without per-route code.
> - **Mobile CSS**: two `@media` blocks added (768px/480px) where previously
>   there were none.
> - **ntfy fix**: `machine.ts`'s notify trigger now reads
>   `NOTIFYING_TASK_STATES.has(toState)` instead of the old `blocked||done`
>   check, sourced from the new `engine/notifications/events.ts` catalog —
>   genuinely fixes the needs-review silent-approval-gate gap. `queued->claimed`
>   for the first claim goes through `transition()`, so "task started" fires on
>   initial claim too.
> - **Test coverage**: spot-checked `tc7_projects_api.test.ts` in full (6 tests)
>   — all match. Counted `it(` blocks in `tc_ntfy_events.test.ts` (7),
>   `tc_ntfy_settings_api.test.ts` (3), `tCONSOLE_projects_render.test.ts` (3) —
>   all match. `contract_d0_c.test.ts` diff confirms endpoint count 27→30, and
>   the ENDPOINTS array literally has 30 entries. The updated
>   `tc_ntfy_task_notifications.test.ts` correctly isolates per-state assertions
>   rather than weakening coverage for the broadened contract.
> - Journal-hygiene invariant (no topic value persisted) is present and tested.
>
> **One caveat**: I could not independently execute `npm run build` or `npx
> vitest run` in this session (review-role command restriction), so the 435/435
> and clean-build claims are taken on the operator's report, not re-verified by
> me. Everything I could inspect statically — diff shape, gate logic, auth
> wiring, test bodies, counts — is accurate and consistent with the walkthrough.
> No discrepancies found.

## Operator verification (the claims the senior could not re-run)
Run by the operator this session, on the branch tip `8ba7563`:
- `npm run build` (tsc --noEmit): exit 0, clean.
- `npx vitest run`: **435 passed / 435 across 94 files** (full suite; subsets run
  in isolation green first, then the full suite).
- Live browser checks (375px mobile viewport): Projects tab + Add modal, zero
  horizontal page overflow, Settings ntfy card lists all 7 events + Send-test
  button.

## Disposition
APPROVE + operator-verified suite/build → cleared for operator merge to `main`.
