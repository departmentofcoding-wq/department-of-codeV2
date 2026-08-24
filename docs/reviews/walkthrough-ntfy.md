# Walkthrough — ntfy notifications + harness fixes (`wt/junior-ntfy-notifications`)

Branch: `wt/junior-ntfy-notifications` (linear stack on `main`). Offered for a
Senior review + merge. This replaces the raw-diff artifact the first review flagged.

## Commits (oldest → newest, all on this branch)
- `5235175` fix(harness): permanently fix Antigravity junior new-conversation
- `1bbee8d` feat(notifications): integrate ntfy notifications for task status changes
- `d1a978c` fix(harness): completion detection no longer reads "working" from agent prose
- (this commit) finish ntfy: topic-hygiene + this walkthrough

Full stack vs `main`: **21 files, +966 / −19**. `git show --stat 1bbee8d` for the
feature alone: **15 files, +844 / −11**.

## 1. ntfy feature (the task — `e489b734`, `1bbee8d`)
The department pushes an ntfy notification when a task gets **stuck** (`blocked`) or
**done** (`done`), with an ntfy settings section in the Operator Console.
- `engine/notifications/ntfy.ts` — the ntfy client (POST to `<server>/<topic>`,
  title/body from task id/title/state/reason), behind `ntfy-seam.ts` (override for
  tests — no network in the suite).
- `engine/state/notifications.ts` — `notifyTaskStateChange`: reads `ntfy_server_url`
  / `ntfy_topic` from `bureau_meta`, sends best-effort, journals a `system` span on
  success and a `guardrail` span on failure. Hooked from `engine/state/machine.ts`
  on the terminal transitions **after the transaction commits** (a failed alert can
  never roll back a real state change).
- Console **Settings → ntfy** (server URL + topic) — `console/server.ts` +
  `contract.ts` + `render.js`/`app.js`; persisted in `bureau_meta` like other settings.
- **Topic hygiene:** the notification span records only `topicConfigured: true`,
  never the raw topic (an ntfy topic is a publish/subscribe address) — mirrors the
  settings-save span's `'configured'`/`'empty'` convention.

## 2. Harness fix — junior new-conversation (`5235175`)
The junior stranded because the harness drove the Agent panel before it mounted.
- `ensureChatInputReady()` waits for the chat input (opens the Agent panel if its
  toggle isn't already active), wired into the seam before any panel interaction.
- `newConversation()` prefers the IDE's real control — the stable
  `data-tooltip-id="new-conversation-tooltip"` header icon (found + verified live).
- Also fixes `scripts/intake.ts`'s broken import (the intake CLI was dead).

## 3. Harness fix — completion detection (`d1a978c`)
The work review "hung" because the waiter read the word **"working"** out of the
senior's own prose ("…working tree clean…") and never concluded.
- New unit-tested `AGENT_PROGRESS_LABEL_RE`: a progress word counts only as the
  ENTIRE text of a childless status element, never a substring of the reply. Both
  waiters (ZCode, Antigravity) inject it; Stop/Cancel stays the primary signal.

## Design notes
- Transport is behind a seam; tests inject a fake — no network in the suite.
- Best-effort, fire-and-forget alert with a journaled success/failure span and a
  short timeout — deliberately NOT a durable `bureau_jobs` row (a lost alert costs
  no pipeline work; a job per push would over-weight it).
- The done-gate is untouched: `done` still requires verifier exit 0 + human approval.
- Config lives in `bureau_meta` (`ntfy_server_url`, `ntfy_topic`).

## Verification (re-runnable)
- `npm run build` → `tsc --noEmit` clean.
- `npx vitest run` → **355/355 across 84 files** (t38 is the known browser-contention
  flake, green in isolation). ntfy: `tc_ntfy_client` (5), `tc_ntfy_settings_api` (3),
  `tc_ntfy_task_notifications` (4). Completion-detection regression:
  `tc_agent_wait` (incl. the "working tree clean" cases).
- Mutation evidence **M-NTFY-1…3** in `docs/mutation-evidence-phase7.md`.
- Harness fixes verified live against Antigravity 9333 (panel ready + fresh
  conversation) and ZCode 9335 (idle correctly detected).
