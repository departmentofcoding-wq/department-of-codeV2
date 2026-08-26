# Senior Verdict — ZCode 3.8.1 senior harness recalibration

**Verdict: APPROVE**
**Senior:** claude (Claude CLI, review-only, fail-closed) — independent of ZCode,
chosen deliberately because reviewing the ZCode driver *with* ZCode would be
circular.
**Reviewed:** `main` → `a1c17b6` on `wt/zcode-send-recalibration` (one commit;
`engine/harness/senior.ts` two hunks + walkthrough doc).
**Walkthrough:** `docs/reviews/walkthrough-zcode-send-recalibration.md`
**Date:** 2026-08-26

## Verdict text (verbatim)

> **VERDICT: APPROVE**
>
> Checked the walkthrough against `git diff main..HEAD`:
> - **Scope**: exactly one commit ahead of `main` (`a1c17b6`), touching only
>   `engine/harness/senior.ts` (two hunks, both inside `ZCodeSession`) plus the
>   new walkthrough doc. Matches spec exactly.
> - **sendPrompt**: submit now clicks `[data-testid="v4-composer-send"]` (with
>   aria-label/type=submit fallback), throws loudly if the button is missing or
>   disabled, and confirms via the button re-disabling or a stop/generating
>   indicator — never via DOM text. Enter is no longer used to submit.
> - **probeActivity**: `working` = `[data-testid="v4-stop"]` (plus label/progress
>   fallbacks); `canSend` = `[data-testid="v4-composer-send"]` present and not
>   working. The old `onHomeScreen`/`SENIOR_HOME_SCREEN_MARKERS` gate is gone from
>   this function.
> - **Pure functions untouched**: `buildReviewPrompt`, `parseVerdict`,
>   `detectUncapturedReview` (still consuming `SENIOR_HOME_SCREEN_MARKERS`) all sit
>   outside the edited hunks — confirmed unchanged.
> - Walkthrough doc present and matches.
>
> One caveat: I could not independently execute `npm test` or `npm run build` in
> this session, so "435/435" and "build clean" are taken on the walkthrough's word.
> Everything else (diff scope, selector logic, pure-function isolation, doc
> content) checks out on static inspection.

## Independent live proof (beyond the static review)
The fix's own correctness was demonstrated live: after it landed,
`run_senior.ts --senior zai` on the console-projects-mobile-ntfy walkthrough
**completed** — the GLM senior worked 8m33s and returned `VERDICT: APPROVE` after
re-running the suite twice and the build. Before the fix the same command failed
at submit; after only the submit half was fixed it failed at a false stall. A full
completion is the calibration proof.

## Operator verification (claims the senior's sandbox couldn't run)
On `a1c17b6`: `npm run build` exit 0; `npx vitest run` 435/435 across 94 files.

## Disposition
APPROVE + operator-verified + live end-to-end proof → cleared for operator merge
to `main`.
