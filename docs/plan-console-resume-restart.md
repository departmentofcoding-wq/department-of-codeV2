# Plan — Console Resume button + stall visibility (operator recovery, last mile)

Status: REVISION 2 (verified against live DB + code; corrections folded in) ·
Filed after the 2026-08-30/31 stall incident (journal #867, #875). Untracked
until approved.

## The incident (evidence, live db/bureau.db)

Two live tasks are stranded and nothing in the system will ever move them
again:

| Task | Title | Task state | Pipeline job | Job state | Terminal error (journal) |
|---|---|---|---|---|---|
| `3756ec6e…` | Add a hello marker file | queued | `plan.cycle:3756ec6e…` | dead (attempts 2, reaped 1) | #867 "Antigravity IDE workbench window did not become available in time." (2026-08-29 — on the pre-Stream-3 20s code) |
| `b55e2fda…` | Window-lease heartbeat (Phase 8 P1.2) | queued | `plan.cycle:b55e2fda…` | dead (attempts 1) | #875 "The prompt did not land in the chat input ('Message input') — focus was lost or the selector is stale." (2026-08-30 18:31) |

Plus one stale record, NOT a live leak: dispatch row `eb5b0aaa…` (task
`e156395d…`) shows `status:'running'` since 2026-08-27, but its window lease
was reaped the same day and the task's latest dispatch job is **dead**
(`8c3637f8…`). It is an orphaned `running` journal/dispatch record — cleanup
material, not a running job. It is exactly the `DISPATCH_NO_LIVE_LEASE`
finding class — but `bureau_watchdog_findings` is EMPTY: `watchdog.sweep`
has run exactly once ever (2026-08-20), because nothing drains jobs unless a
human runs a script.

Operator impact: the dept typed a task, hit enter before the junior IDE was
ready, then a folder click stole focus so the prompt never landed in the
agent's chat input; both dispatches failed TERMINAL after 1–2 attempts, the
tasks fell back to `queued`, and the console offers no button to revive them.

## What already exists (do not rebuild)

- `POST /api/tasks/:id/rekick` (console/server.ts:879) → `rekickTaskFlow`
  (engine/flow/rekick.ts) — the recovery door, fully built and tested
  (test/unit/tc_rekick.test.ts, tc_rekick_api.test.ts):
  - queued task + dead `plan.cycle` → RESET the deterministic job row
    (id contract preserved, audit trail preserved).
  - claimed task + dead `junior.dispatch` → re-enqueue with stored payload.
  - live jobs are NEVER touched (double-prompt guard); wrong states refused;
    every acceptance AND refusal is journaled.
- `GET /api/flow` already returns `is_stuck`, `stuck_reason`,
  `last_activity_ts/kind` per task — the stall badge needs no new backend.
- `GET /api/findings` serves active watchdog findings.
- UI precedent for task actions: `.btn-approve/complete/archive/reopen/unarchive`
  in console/public/render.js + app.js (confirm dialog → POST → toast).
- Cold-start readiness: Stream 3 merged the workbench attach budget
  (`MAIN_WINDOW_ATTACH_MS` = 60s, antigravity-seam.ts:114; main ≥ b24c516,
  further hardened in 7163e72). The #867 failure class predates it — it is
  NOT open work. Consequence: any runner we start must run current main.

**The only missing pieces are a button, a badge, and a resident drain.**
Everything else is visibility and cadence, not new machinery.

## P0 — PREREQUISITE: a resident runner (the actual self-healing fix)

Resume only resets dead jobs; without a drain loop they still go nowhere —
that is precisely why nothing has moved since 2026-08-30 18:31. Before any
UI work:

1. Run `npm run runner` as a supervised background process (Windows
   scheduled task at logon, or NSSM/similar), started from **current main**
   (≥ `7163e72`) so junior dispatch carries the 60s workbench-attach budget.
   The runner is a poll-loop daemon (`runner/main.ts` drain loop +
   `BUREAU_POLL_MS`); one instance, one window lease at a time.
2. Console boot re-arm: when the console starts, if no pending/running
   `watchdog.sweep` job exists, enqueue `console-watchdog.sweep-latest`
   (the id the sweep chain already uses) so the cadence restarts with the
   console. The sweep re-enqueues itself on a bounded cadence
   (sweep.ts:236, job-chain, no setInterval) — the chain only died because
   no runner drained it.

Acceptance: with the resident runner up, a re-kicked job is claimed and
drained within one poll interval; a sweep triggered once continues on
cadence without any human action.

## P1 — "Resume" button in the Tasks (live) view

- render.js: on live rows where `state` is `queued` or `claimed`, render
  `btn-rekick` labeled **Resume** (title: "Re-kick this task's dead pipeline
  job (plan.cycle / junior.dispatch). Live jobs are never touched.").
  Absent for every other state — the done-gate stays absolute.
- **Default, not stretch:** disable Resume when the row's target job is
  live — the view already fetches `/api/flow`; gate the button on it, with
  a tooltip ("pipeline job running"). The server-side refusal is the safety
  net, not the UX: an operator who clicks Resume on a live `claimed` row and
  gets a refusal toast will read the feature as broken.
- app.js: wire exactly like `.btn-approve` — `promptConfirm` →
  `POST /api/tasks/{id}/rekick` body `{rekickedBy:'human-operator'}` →
  toast; the toast must distinguish the three success actions
  (`plan-cycle-reset` / `plan-cycle-enqueued` / `dispatch-reenqueued`) and
  surface refusal reasons verbatim (server already journals
  `rekick_refused` guardrail spans).

Acceptance / tests:
- From the console alone (no devtools, no node scripts), an operator can
  resume both stranded tasks above; the toast names the reset job.
- Unit tests on the render helper: button present for queued/claimed;
  absent for done/needs-review/archived; **disabled when the target job is
  live**; toast copy distinguishes the three success actions and the
  refusal path. API contract unchanged (already covered by tc_rekick_api).

## P2 — Make "stalled" visible before the operator has to guess

- Tasks (live) table: a **Stalled** badge from `/api/flow`'s existing
  `is_stuck`/`stuck_reason`; tooltip shows `stuck_reason` +
  `last_activity_kind @ last_activity_ts`. No backend change.
- Findings view: each active finding row gets the same Resume button when
  its subject task is queued/claimed (findings are the diagnosis; Resume is
  the cure; the rekick guardrails still apply).

Acceptance: a task whose pipeline job died shows the badge within one
refresh; the badge text matches `stuck_reason` from the API.

## P3 — Bounded auto-recover (the only new machinery, and it is small)

Wire findings → `watchdog.recover` (job kind + `tasks.recover_attempts`
column already exist) with a cap of 1 automatic recovery; after that the
finding stays open for the operator's Resume. Never auto-touch live jobs.

Acceptance: with the resident runner up, a dead `plan.cycle` produces an
active finding within one sweep cadence; one auto-recover attempt occurs;
further recovery requires the operator; journal shows each step.

## Deliberately NOT in this stream

- A second, destructive "Restart from scratch" button. `rekick`'s dead-job
  reset already is restart (attempt counters reset, payloads reused);
  force-discarding work or worktrees is against bureau guardrails (dirty
  worktrees are never force-deleted — same posture as the Stream-5 prune
  work). If a true fresh-restart is ever wanted, it is a separate proposal.
- Engine-side root causes, filed separately:
  - **Open:** "prompt did not land" fails terminal after ONE attempt
    (antigravity.ts:879). The engine already *detects* non-landing and
    fails closed — the improvement is a bounded re-focus-and-retry before
    going terminal. Better still, port the **readiness gate** pattern from
    the senior side (`senior.ts` sendPrompt + the new
    `waitForWorkbenchReady`) into junior dispatch, which can prevent the
    focus-loss window entirely rather than retrying after it.
  - **Done, do not re-file:** wait-for-workbench cold start (Stream 3,
    `MAIN_WINDOW_ATTACH_MS` 60s, merged b24c516; hardened in 7163e72). The
    #867 failure predates the fix. Residual action is operational only:
    the resident runner must run current main (P0.1).
  - The zombie-lease class itself is already task `b55e2fda` (window-lease
    heartbeat) — note it is currently one of the stranded tasks it would
    fix; resume it first so it can ship its own cure.

## Immediate recovery (today, before any of the above ships)

1. Make the junior ready: close the stale Antigravity window parked on the
   empty `5d29e47b…` worktree (that task is DONE, PR #3 merged — its
   worktree was pruned; the leftover empty dir also caused EPERM #803);
   don't interact with the IDE while a dispatch is in flight.
2. Re-kick both tasks from the console browser's devtools (the page holds
   the auth token in sessionStorage):
   ```js
   for (const id of ['3756ec6e-4ee5-4110-aa6a-b64d3831c464',
                     'b55e2fda-5309-42c9-a356-2a7971c98543']) {
     fetch(`/api/tasks/${id}/rekick`, {
       method: 'POST',
       headers: { 'x-console-token': sessionStorage.getItem('x-console-token'),
                  'content-type': 'application/json' },
       body: JSON.stringify({ rekickedBy: 'operator' })
     }).then(r => r.json()).then(console.log);
   }
   ```
3. In `D:\Dept of code v2`, start the resident runner on current main
   (P0.1) and leave it running to drain the reset jobs — serially; one
   window lease at a time.
4. Once the runner is resident, trigger one watchdog sweep (existing
   console button → `/api/actions/trigger`) to re-arm the cadence chain,
   and run `scripts/reconcile_live_tasks.ts` for the legacy stranded rows
   (incl. the orphaned-running dispatch record on task `e156395d…`).
