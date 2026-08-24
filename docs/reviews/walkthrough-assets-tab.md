# Walkthrough — `wt/junior-assets-tab` (Department Assets + first-run fixes + bounded work-review loop)

Branch tip: `05dd8fb`. Base: `main` (`874162a` is the branch's own first commit).
Suite: **340/340 across 81 files, `npm run build` clean, run twice.**

This branch bundles three things. It is offered for a senior review + merge decision.

## 1. Department Assets tab (`874162a`, the original first-run feature)
A CRUD "Assets" inventory in the Operator Console: `bureau_assets` table + schema,
4 token-authed endpoints (`GET/POST /api/assets`, `POST /api/assets/:id/update`,
`POST /api/assets/:id/delete`), DTOs, and a frontend tab with an add/edit modal.
Guards: name/url validation (400), fail-closed auth (401 + guardrail span),
`updated_at` refresh. Mutation evidence M-ASSET-1/2/3 in
`docs/mutation-evidence-console.md`. Tests `tc6_assets_api` (7) + `tCONSOLE_assets_render`.

## 2. First-run fixes (`5f1f5d8`)
Cut against the gaps the first real end-to-end run (task `82b97764`) exposed.
- **Dead backup fixed** — `engine/contract/backup-seam.ts` used `require()` in an ES
  module, so every `backup.push` died with "require is not defined" (zero working
  backups since 08-20). Now a top-level import. Regression test `tc_backup_seam`.
- **Plan→work loop closed** — plan approve/ceiling now transitions `queued→claimed`
  (no more zombie stuck in `queued`) and flags the implementation dispatch
  `chainWorkReview`; on completion `junior.dispatch` enqueues a `work.cycle` so a
  senior actually reads the walkthrough.
- **Honest implementation prompt** — no longer claims "APPROVED" on the ceiling
  path; threads the senior's final required changes to the junior.
- **XSS guard** — `safeHref` in the console renders only http(s) as links;
  `javascript:`/`data:` URLs in the Assets tab are inert text. Mutation M-HREF.
- **History log grouped by task** — `renderJournalTimeline` renders one section per
  task with a titled header + count; system actions grouped last.
- **Plan-rounds ceiling 3 → 7** (constant + live meta).
- Mutation evidence M-HREF, M-LOOP, M-BACKUP in `docs/mutation-evidence-phase7.md`.

## 3. Bounded work-review loop (`05dd8fb`)
The work review now cycles like the plan review. On **REVISE** the senior's required
changes are fed back to the SAME junior (a fresh `junior.dispatch` that continues its
conversation, `chainWorkReview=true`); the junior implements them and its new
walkthrough is re-reviewed by the SAME senior — looping until **APPROVE**, bounded by
`review:work_rounds_ceiling` (default **5**). At the ceiling the task is **blocked**
and surfaced to the operator, never looped forever. `cycles` counts the rounds.
Mutation M-WLOOP. Tests `tc_work_cycle` (6).

## Invariant preserved
The done-gate is untouched: reaching `done` still requires **verifier exit 0 + human
approval** (`engine/state/machine.ts`). None of these changes mark a task done or
bypass the DB invariant. The still-open architectural item: the harness junior writes
in its own IDE workspace, not a bureau worktree, so automatic `verify.run → needs-review`
against the junior's branch remains a separate stream.

## Verification run
- `npx vitest run` → 340/340, 81 files (twice).
- `npm run build` (`tsc --noEmit`) → clean.
- Mutations M-HREF, M-LOOP, M-WLOOP executed live (guard removed → named test fails →
  restored). M-BACKUP is a regression proof (pre-fix `require` throws at call time).
