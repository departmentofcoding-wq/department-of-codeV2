# Senior Verdict — ntfy Task Notifications + Harness Fixes

**Commit under review:** `f349a13` (tip of `wt/junior-ntfy-notifications`)
**Branch:** `wt/junior-ntfy-notifications` — linear stack on `main` at `06c5d51`:
`5235175` (Antigravity new-conversation fix) → `1bbee8d` (ntfy feature, task
`e489b734`) → `d1a978c` (completion-detection fix) → `f349a13` (topic hygiene +
this walkthrough).
**Scope:** ntfy.sh push notifications on `blocked`/`done` task transitions with a
Console settings section; junior new-conversation readiness gate; agent
completion-detection fix ("working" in reply prose no longer counts as
generating); `scripts/intake.ts` import repair.
**Date:** 2026-08-24
**Verdict:** ✅ **APPROVE — merged to main** (`1c14534`, `--no-ff`, local only,
not pushed). Citation errata and a process slip remediated by the Senior in the
commit carrying this verdict.

## What was verified (independently, not trusted)

- **Suite + build, re-run by the Senior on the branch tip:** `npx vitest run` →
  **355/355 across 84 files**, exit 0 — t38 did not flake in this run, so no
  isolation re-run was needed; `npm run build` → `tsc --noEmit` clean, exit 0.
  Both match the walkthrough's headline claims exactly.
- **Stack + stats:** exactly the 4 commits claimed, linear. `git show --stat
  1bbee8d` → **15 files, +844/−11** (exact match). Full stack at tip: 22 files,
  +1032/−19 (see errata #2).
- **Topic hygiene (the first review's demand):** the notification span in
  `engine/state/notifications.ts` journals `topicConfigured: true` — never the
  topic value; the Console settings-save span records `topic:
  'configured' | 'empty'`. Both journal doors audited; no code path writes the
  raw topic into `bureau_journal`. The untracked task artifacts were grepped:
  no raw topic, no server credentials, no key material.
- **Hook placement:** `notifyTaskStateChange` fires only AFTER
  `db.execTransaction` returns (post-commit), only on `blocked`/`done`, and is
  `.catch()`-ed fire-and-forget — a failed alert can neither roll back nor
  delay a state change. The done-gate is untouched by the diff (import +
  variable rename + hook only); `done` still requires verifier exit 0 + human
  approval.
- **No network in the suite:** all three ntfy test files inject a fake
  transport (`setNtfyTransportOverride` or constructor transport); integration
  tests run on the fixtures-factory DB, never the live `db/bureau.db`, and
  clean up.
- **Settings API:** GET/POST `/api/settings/ntfy` behind `x-console-token`
  (401 fail-closed test passes); URL scheme guard rejects non-http(s) with 400
  `INVALID_URL`; `bureau_meta` persistence asserted directly.
- **Mutation representative re-executed (M-NTFY-2):** the Senior mutated
  `machine.ts` dispatch `'blocked' || 'done'` → `'done'` and observed **2
  failed / 2 passed** in `tc_ntfy_task_notifications.test.ts` — identical to
  the recorded evidence; restored via `git checkout`, re-run **4/4 green**,
  tracked tree clean afterwards. M-NTFY-1/M-NTFY-3 accepted on the recorded
  evidence (guards cross-checked by reading the tests).
- **Completion-detection fix:** `AGENT_PROGRESS_LABEL_RE` is anchored
  (`^…$`, progress word + optional dots only) and BOTH waiters (ZCode,
  Antigravity) additionally require a childless element whose ENTIRE text
  matches — the literal regression ("working tree clean" in senior prose) is
  pinned in `tc_agent_wait.test.ts`. Stop/Cancel remains the primary signal in
  both probes.
- **New-conversation fix:** `ensureChatInputReady()` gates the Antigravity seam
  before any panel interaction, with a toggle-click guarded against closing an
  already-open panel; `newConversation()` prefers the stable
  `data-tooltip-id="new-conversation-tooltip"` control. The `scripts/intake.ts`
  repair is the described one-line import fix.

## Citation errata (remediated by the Senior in this commit)

1. The walkthrough claimed ntfy per-file test counts **5 / 3 / 4**; reality is
   **4 / 4 / 4** (`tc_ntfy_client` / `tc_ntfy_settings_api` /
   `tc_ntfy_task_notifications`). The ntfy total (12) and the suite headline
   (355/355, 84 files) were correct. Corrected in `docs/reviews/walkthrough-ntfy.md`.
2. The walkthrough's "Full stack vs main: 21 files, +966 / −19" measured the
   stack WITHOUT the walkthrough's own commit; at tip it is **22 files,
   +1032 / −19**. Corrected with annotation.
3. `docs/mutation-evidence-phase7.md` footer says "353/353 across 84 files" —
   true when recorded at `1bbee8d`, stale at tip (`d1a978c` added 2 tests →
   355). Left as written (it documents the restoration as executed at that
   commit); this verdict records the tip numbers.

## Process note (remediated)

The junior's task artifacts (`docs/junior-artifacts/e489b734-…/`: transcript,
reply, and the superseded raw-diff walkthrough the first review flagged) were
left **untracked** in the checked-out tree — bureau law says junior work is
committed on the stream branch, and the archive convention (`82b97764`,
`clicker-test`) commits them. Remedied: archived in this commit (17K, scanned
for secrets beforehand).

## Non-blocking notes (operator advisories)

- The `done` notification fires only after the done-gate (verifier exit 0 +
  human approval) because it hooks the transition itself — no bypass path.
- The transport is deliberately best-effort (5s timeout, no retry, no
  `bureau_jobs` row) — accepted per the design note; a lost alert costs no
  pipeline work. If an alert is ever missed in practice, promote it to a
  durable job then, not speculatively.
- Live notification is inert until the operator sets `ntfy_topic` in Console →
  Settings (no topic → safe no-op); `ntfy_server_url` defaults to
  `https://ntfy.sh`.

**Merge record:** `main` @ `1c14534` (`git merge --no-ff wt/junior-ntfy-notifications`,
local only — no push). Post-merge `git diff wt/junior-ntfy-notifications main` is
empty: main's tree is identical to the reviewed tip `f349a13`.
