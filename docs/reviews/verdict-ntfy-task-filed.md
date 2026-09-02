# Senior verdict — ntfy push on task filing (operator-requested feature)

- **Branch:** `wt/ntfy-task-filed` (tip `b14a443`; feature commit `b29ae6e`)
- **Base:** `acd7930` (local main)
- **Senior:** claude (Claude Code CLI, `claude -p --append-system-prompt`, adversarial
  static/close-read review — the `claude -p` sandbox cannot run the suite, so the senior
  reasoned from the full diff + independently-supplied evidence)
- **Kind:** phase4 (engine-dev code-diff review)
- **Date:** 2026-09-02
- **Verdict:** **APPROVE**

## What was reviewed
Operator request: "every time a task is filed, update the dept to send my ntfy; ensure
that is updated in the settings as well." The events catalog (`engine/notifications/
events.ts`) gains `task.filed` with `taskState: 'queued'` — the single source of truth
for BOTH the firing gate (`NOTIFYING_TASK_STATES`) and the console Settings list, which
spreads the catalog (`console/server.ts`, unmodified). `fileTask` fires the push AFTER
its filing transaction commits (best-effort `void …catch`, mirroring machine.ts's
transition hook), gated on the catalog, only on the fresh-INSERT path — the idempotent
re-file returns without a second push. A filed task is born `queued` via INSERT, not
`transition()`, so `file_task.ts` is the only place the entry-to-queued push can
originate. Styling: `queued` = default priority, `inbox_tray,memo` tags. Mutations
M-NTFYF-1/M-NTFYF-2 recorded (`docs/mutation-evidence-phase8.md`).

## Senior's findings (summary)
All eight department invariants checked and clean, by close read of the diff AND the
surrounding code (`state/notifications.ts`, `state/machine.ts`, `notifications/ntfy.ts`,
`ntfy-seam.ts`, `contract/constants.ts`, `console/server.ts`):
1. Done-gate untouched (`machine.ts` not in the diff).
2. No network in tests — the new test installs the transport override in `beforeEach`.
3. Journal hygiene — the shared `notifyTaskStateChange` span records `topicConfigured`
   only, never the topic value.
4. No secrets introduced.
5. Post-commit + best-effort: `void … .catch(() => {})`, structurally identical to the
   existing transition hook; no rollback path.
6. Idempotency: `insertedNewTask` set only on the fresh-INSERT branch; BOTH idempotent
   return branches (`filed` at the top, concurrent re-read) return before it — verified
   by reading the full function, not just the diff hunk.
7. Not a job row — consistent with the existing claimed/needs-review/done notifications,
   which are fire-and-forget side effects of `transition()`.
8. Scope: the senior independently grepped for `transition(db, …, 'queued', …)` across
   `engine/` — zero production call sites (rearm goes `blocked→claimed` directly), so the
   only production behavior change is the filing push. `approveTask`/`rearmTask`/verify/
   intake confirmation unmodified. Settings propagation automatic.

Also verified: the new integration test's expected title/priority/tags/body match
`NtfyClient.sendNotification`'s actual formatting, and the intake fixture satisfies
`taskGaps` exactly. "No defects found."

## Evidence supplied
Full suite **677/677 across 123 files** + `tsc --noEmit` clean on the branch tip;
mutations M-NTFYF-1 (firing site disabled → 1 test fails) and M-NTFYF-2 (catalog
`taskState` stripped → 3 tests fail) both reproduced then restored green.
