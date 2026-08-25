# Senior Verdict — Completed/Done tag for shipped tasks + out-of-band-merge rule

- **Branch:** `wt/task-completion-tag` (base `main` @ `17cdb15`)
- **Commits under review:** `f371354` (Completed tag feature) and `1929bf9`
  (out-of-band-merge rule, docs only); `8f97af8` is the walkthrough itself.
- **Reviewer:** ZAI senior (GLM/ZCode), 2026-08-25
- **Verdict:** **APPROVE** — with one governance note (below) on how this
  branch itself may be merged.

## What was independently verified (not trusted from the walkthrough)

1. **Suite twice + build.** `npx vitest run` → 384/384 across 88 files, twice,
   zero flakes; `npm run build` (`tsc --noEmit`) clean. Matches the claim
   (baseline 375/375; +9 net).
2. **Diff review.**
   - `engine/db/schema.ts`: `completed_at/completed_by/completion_commit/
     completion_note` added in all three places (base CREATE, `ADDED_COLUMNS`,
     legacy-rebuild CREATE + INSERT/SELECT lists). The done-gate CHECK is
     byte-identical.
   - `engine/state/completion.ts`: `markTaskCompleted`/`reopenTask` mirror the
     reviewed archive pattern — operator-gated, transactional, idempotent
     (guarded `UPDATE … WHERE completed_at IS NULL … RETURNING`), one journaled
     `human` span per act, never writes `state`.
   - `console/server.ts` + `contract.ts`: `GET /api/tasks/completed`,
     `POST /api/tasks/:id/{complete,reopen}`; token-gated like the rest;
     refusals journaled as `guardrail` spans without a taskId (FK-safe);
     outputs `redactOutput`-ed; live list + `statePopulations`/`budgetSpend`/
     `taskFlow` exclude completed AND archived; ENDPOINTS 24 → 27 with the
     count test updated.
   - Frontend: Live/Completed/Archived segmented control; every
     user-controllable field (note, commit, id, title) goes through
     `escapeHtml` — verified in the render diff and covered by render tests
     (incl. the standing XSS suites #9/#10).
   - `scripts/reconcile_live_tasks.ts`: the two shipped tasks are now
     un-archived (if previously archived) then tagged completed with the
     shipping commit; test artifacts stay archived; idempotent.
3. **Mutation evidence.** Junior shipped none (flagged honestly in the
   walkthrough); Senior executed M-COMP-1 (operator gate) and M-COMP-2
   (live-list exclusion) — recorded in `docs/mutation-evidence-phase7.md`:
   mutate → real test fails → restore → green.
4. **Live DB re-inspected.** Backup `db/backups/bureau.pre-complete-
   20260825-081734.db` exists; final state: `82b97764`→completed @`c7f9b37`
   (state still `queued`), `e489b734`→completed @`1c14534` (state still
   `claimed`), the two `live-mt*` artifacts archived, **zero `done` rows**;
   four attributed `human` spans (254–257: unarchive+complete pairs).
5. **The rule text (`1929bf9`)** was reviewed as carefully as the code. It is
   coherent with the operator's decision, records the real incident with the
   DB evidence, and lands the pause without ambiguity: work finishes on its
   `wt/...` branch and is left for the operator; no hand `git merge`/`git
   commit` to `main` outside the tracked delivery path until the
   workspace/worktree reconciliation stream lands.

## Defects found

None blocking. Two notes for the record:

- The investigation's root-cause table (0 worktrees / 0 verify.run / 0 pr.* /
  0 merge spans) matches what the Senior independently observed in the live
  DB during the 08-24 review, and the "peer session doing raw git" conclusion
  is the only explanation consistent with the evidence (no hook/cron/task).
- Minor: `reopenTask` journals `{ action: 'reopen' }` without echoing the
  prior completion commit; cosmetic, not a defect.

## Governance note — how this branch merges

This branch makes hand-merges to `main` a rule violation. Under the law
currently on `main` (verdict-gated operator merge), merging this branch after
this verdict would be legal; under the rule this branch introduces, it would
not. The Senior's position: the verdict is posted for `f371354` + `1929bf9`,
the branch is ready, and the merge decision belongs to the human operator —
either (a) one final verdict-gated hand-merge to enact the rule as law, or
(b) hold until the reconciliation stream lands and deliver it through the
tracked path. The Senior has deliberately NOT merged it.

**Verdict: APPROVE for `f371354` and `1929bf9`.**
