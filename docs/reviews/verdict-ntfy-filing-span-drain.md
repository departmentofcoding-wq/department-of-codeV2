# Senior verdict — filing-notification drain (journal-span race fix)

- **Branch:** `wt/ntfy-filing-span-drain` (tip `d53b6ff`; fix `fdbcb01`, evidence `46a32f8`, amendment `d53b6ff`)
- **Base:** `5334ab9` (merged main, carries the approved ntfy-on-filing feature)
- **Senior:** claude (Claude Code CLI, `claude -p --append-system-prompt`, adversarial static/close-read)
- **Kind:** phase4 (engine-dev code-diff review), two rounds
- **Date:** 2026-09-02
- **Verdict:** round 1 **REVISE** → round 2 **APPROVE**

## What was reviewed
Live scar (2026-09-02, observed on the real N15 filing): the `task:file` CLI DELIVERED the
QUEUED push to ntfy (confirmed on the topic cache) but its `ntfy_notification` journal span
was lost — the fire-and-forget push raced the CLI's `finally { db.close() }`, so the
post-send journal write hit a closed DB. Fix: `file_task.ts` tracks the in-flight filing
push in a module-level set; `drainFilingNotifications()` polls it to empty; both CLI doors
await it before closing.

## Round 1 — REVISE (one required change)
The senior verified the drain loop (no deadlock: `.catch` guarantees settle, `.finally`
unconditionally removes; the while-loop re-polls the live set — independently corroborated
by the disclosed INERT mutation), the self-referencing `.finally` closure (no TDZ), that
long-lived callers are untouched (fire-and-forget parity with machine.ts), that a hung
transport is pre-existing hard-bounded (5s AbortController in `ntfy-seam.ts`), journal
hygiene, and the unchanged idempotent re-file. **It then caught a real gap by reading the
call graph:** `scripts/intake.ts`'s DEFAULT conversational path (`drainSingleJob` →
`intake.turn` → officer's `file_task` tool → `fileTask`, synchronous in-process) still fell
through to `db.close()` undrained — the same race on the main path, untested.

## Round 2 — APPROVE
Amendment: `await drainFilingNotifications()` on both `db.close()` sites in
`scripts/intake.ts` (the `--file` branch and the post-`drainSingleJob` default path), plus
the demanded regression test — the officer files via a real drained `intake.turn` job
(MockClient tool calls, gated transport proving the span is absent mid-flight and present
after the drain). The senior confirmed the handler wiring (`registry.ts` → `runOfficerTurn`
→ `fileTask` → the shared pending set), the import/export graph, and the afterEach
override cleanup.

## Evidence
Suite 677 → 679 green across 123 files on the branch tip; `tsc --noEmit` clean.
Mutations: M-NTFYF-3b (set membership removed → drain no-ops → gated test fails
deterministically; an initially-attempted allSettled mutation was INERT because the
while-loop re-polls — disclosed in `docs/mutation-evidence-phase8.md`).
