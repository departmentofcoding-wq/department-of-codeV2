# Senior verdict — Junior B (Antigravity 2.0) delivery via single-window path

- **Branch:** `wt/junior-b-delivery-path` @ `d6d79cf` (feature `f416256` + senior-nit `d6d79cf`)
- **Against:** main `2e468c9`
- **Reviewer:** claude senior (independent subprocess, `claude` agent, headless
  agentic — file reads + greps + live vitest/mutation runs in this repo; the
  implementer is a different session)
- **Kind:** engine-dev code-diff review of the full change (6 files)
- **Date:** 2026-09-02
- **Mutations:** M-B1/M-B2 (`docs/mutation-evidence-phase8.md`)

## Context

Junior B is **Antigravity 2.0** — a standalone single-window agent app, not the
VS Code fork (junior A). It has no per-folder CDP windows, so the folder-window
delivery path (`ensureFolderWindowWs` waiting for a `"<base> - Antigravity IDE"`
title) timed out on every delivery dispatch and killed task N9 (`693ad95a`).
Root cause confirmed live on CDP port 9334: single window titled `"Antigravity"`,
project-organized, `Antigravity.exe <folder>` opens no new CDP target. B's
in-chat DOM landmarks (input/model/send) already worked and are unchanged.

## Verdict

**APPROVE** — zero blockers, zero majors, zero minors. One non-blocking nit
(a stale N16 comment) fixed in the follow-up commit.

Independently verified by the reviewer (paths traced from source, not the commit
message):

1. `resolveDeliveryStrategy` (`engine/harness/antigravity.ts`) routes all four
   cases correctly: A+required→folder-window; B+required→main-window+inject;
   planning (requireFolder false) and no-folder→main-window, no injection, for
   both juniors. B can never reach `ensureFolderWindowWs` (gated solely on
   `strategy.attach === 'folder-window'`). A's proven path is behaviorally
   identical to the old `if (opts.folder && opts.requireFolder)` branch; the
   `opts.folder!` assertion is sound.
2. The prompt-gate invariant holds: `buildWorktreeDirective` is PREPENDED and ends
   in `\n\n`, so the effective prompt's LAST line (the N0 completion instruction)
   is unchanged — the anchor for `sliceAfterPrompt`/`juniorCompletionEvidence`
   and for reply/plan/walkthrough slicing. All four consumers use
   `effectivePrompt` consistently. Appending would have moved the anchor; prepend
   is the correct choice, and the test at `tc_antigravity.test.ts` exercises it
   (echoed→false, replied→true).
3. No fake guards / dead code: the new functions are pure and directly exercised.
   The reviewer ran the **M-B1 mutation live** — flipping `JUNIORS.B.windowModel`
   to `'folder-window'` fails exactly the 2 documented tests; restore → 30/30.
   M-B2 caught by the B-required `injectWorktreePath === WT` assertion.
4. The N16 primary-tree contamination guard (`engine/harness/dispatch-job.ts`) is
   untouched and still fires for B — it keys off `deliveryWorktreePath`,
   independent of junior identity or window model. Not weakened.
5. Fail-closed laws preserved: folder-window still fails hard rather than run in
   the wrong workspace; main-window attach still throws with no ws URL;
   `folderSelected=true` on the B branch is observability-only (honest: "worktree
   scope conveyed via the prompt"), with N16 as the real safety net.

## Findings

- **nit (fixed)** — `dispatch-job.ts:332-333`: the N16 comment said "requireFolder
  + a dedicated folder window", stale for B's single-window path. Corrected in the
  follow-up commit (comment only; guard logic unchanged).

## Suite

`npx tsc --noEmit` exit 0; `npx vitest run` **723/723 across 128 files** green
(reviewer ran tsc + the antigravity suite + the full suite; M-B1 executed and
restored).
