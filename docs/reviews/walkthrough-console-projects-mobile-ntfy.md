# Walkthrough — Console Projects tab + mobile-responsive UI + ntfy notification expansion

Branch: `wt/console-projects-mobile`
Review range: `main` (`0ca54f6`) → tip `8ba7563` — two commits, 18 files, +1179 / −155.

This branch is a console/notification stream (not an intake-filed task). It has
two independent, related features. Both are additive to the Operator Console.

## Task / intent (verbatim from the operator)

1. Add a way in the console to **view projects and add projects** in the UI; a
   project needs a **description** and a **folder location** (record where the
   repo lives on disk). The multi-repo engine (`bureau_projects`,
   `registerProject`/`listProjects`) already existed but was CLI-only.
2. Make the console **mobile-friendly** (it is reached from a phone).
3. Fix the **ntfy notification gap**: notifications only fired on `blocked`/`done`,
   so `needs-review` — the state that needs the operator to approve — sent no
   push. Also: add a Settings list of **what sends notifications**, add pushes for
   **department online**, **task started**, and **task finished**, and add a
   **test notification** button.

## Commit 1 — `f6c0560` Projects tab + mobile-responsive UI

### Projects (view + add)
- `console/contract.ts`: new `ProjectDTO` (id, name, path_to_repo, description,
  timestamps) + `CreateProjectRequest` (name, pathToRepo, description). Two new
  endpoint manifest entries. `ENDPOINTS` 27 → 29.
- `console/server.ts`: `GET /api/projects` (→ `listProjects`, redacted DTOs) and
  `POST /api/projects` (→ `registerProject`). Registration REUSES the engine
  helper unchanged, so the on-disk gate stays intact: the folder must exist AND
  be a git repo, `/.bureau-worktrees/` is auto-added to its `.gitignore`, and a
  `project-registered` journal span is written. A blank name/path → 400
  `VALIDATION_ERROR`; a non-repo path → 400 `PROJECT_REFUSED` with a guardrail
  span (never persisted).
- Frontend: a **Projects** nav tab + read-only table (name, folder location,
  description, registered-at) + a **+ Add Project** modal (name, folder path,
  description). All token-guarded and XSS-escaped via `escapeHtml` like every
  other view (`renderProjectsTable`).
- The engine schema already stores one folder (`path_to_repo`) + `description`
  per project — the UI surfaces and sets both; no schema change.

### Mobile-responsive
- `console/public/styles.css` previously had a viewport tag but **zero `@media`
  queries**, so on a phone the single-row header and 8-column tables overflowed.
  Added `@media (max-width: 768px / 480px)`: header stacks, nav scrolls sideways
  instead of wrapping, wide tables scroll inside their own card (`overflow-x`),
  dashboard goes single-column, modals go full-width, toasts span the bottom.

### Evidence
- New tests: `tc7_projects_api` (6: list, create+journal span, validation,
  folder-gate refusal + guardrail, auth fail-closed, manifest),
  `tCONSOLE_projects_render` (3: fields, XSS escape, empty state).
  `contract_d0_c` endpoint count updated 27 → 29.
- Live browser check at 375px: Projects tab loads, seeded project renders with
  its folder path, Add modal opens; `document.body.scrollWidth === clientWidth`
  (zero horizontal page overflow); header computes `flex-direction: column`,
  nav + table-card compute `overflow-x: auto`.

## Commit 2 — `8ba7563` ntfy: needs-review + started/online/failed + Settings list + test

- `engine/notifications/events.ts` (NEW): single source of truth
  `NOTIFICATION_EVENTS` + derived `NOTIFYING_TASK_STATES`. Events: dept.online,
  task.started (claimed), task.needs-review, task.blocked, task.failed,
  task.done, ntfy.test.
- `engine/state/machine.ts`: the notify trigger changed from the hardcoded
  `toState === 'blocked' || toState === 'done'` to
  `NOTIFYING_TASK_STATES.has(toState)` — so entry to `claimed` (started),
  `needs-review`, `blocked`, `failed`, `done` all notify. **This is the fix**:
  `needs-review` (the human-approval gate) now pushes.
- `engine/notifications/ntfy.ts`: per-state priority/tags table (needs-review =
  high priority + `eyes,bell`; started = `rocket`; failed = `x,rotating_light`;
  blocked/done unchanged). New generic `sendMessage()` for non-task pushes;
  `sendNotification()` refactored to delegate to it (existing formatting
  preserved — `tc_ntfy_client` still green unchanged).
- `engine/state/notifications.ts`: `readNtfyConfig()` helper;
  `notifyDepartmentOnline()` (fired from `scripts/console.ts` when the
  console/runner starts, best-effort, no-op without a topic);
  `sendTestNotification()` returning `{configured, sent}`.
- `console/server.ts` + `contract.ts`: `GET /api/settings/ntfy` now returns the
  `events` catalog (drives the Settings list, so it can't drift from what fires);
  new `POST /api/settings/ntfy/test`. `ENDPOINTS` 29 → 30.
- Frontend: the ntfy settings card lists every notifying event and has a **Send
  test** button (disabled until a topic is configured).

### Journal hygiene (unchanged invariant)
Notification spans record only `success` + `topicConfigured: true` — never the
topic value (an ntfy topic is a publish/subscribe address). Verified by a test
asserting the span does not contain the topic string.

### Evidence
- New tests: `tc_ntfy_events` (7: NOTIFYING set membership; needs-review fires
  high-priority + `eyes` tag; claimed fires; dept-online sends/ no-ops + span;
  test send `{configured,sent}` + human span; generic `sendMessage`; catalog),
  `tc_ntfy_settings_api` (3: GET returns events; POST test configured:false with
  no topic; POST test sends with a topic, correct URL + title).
- `tc_ntfy_task_notifications` (existing integration) updated to the broadened
  contract: isolates each transition by state rather than asserting a single
  post; the old test encoded the blocked/done-only behavior this change replaces.
- `contract_d0_c` endpoint count 29 → 30.
- Live browser check: the Settings card renders all 7 events + an enabled Send
  test button when a topic is configured.

## Suite + build (operator-run)

- `npm run build` (tsc --noEmit): exit 0, clean.
- `npx vitest run`: **435 passed / 435 across 94 files** on the branch tip. (Ran
  the projects+mobile subset and the ntfy subset in isolation too — green — then
  the full suite twice across the two commits.)
- No changes to the done-gate, state-machine transition table, verify, filing,
  or intake logic. The trigger predicate is the only machine.ts change and it
  only widens WHICH states notify — transitions themselves are untouched.

## Scope notes for the reviewer
- `NtfySettingsDTO.events` is optional in the contract so existing partial
  fixtures still typecheck; the server always populates it.
- No real ntfy push is sent anywhere in tests (transport is overridden with a
  capture mock); the dept-online and test-send paths are no-ops without a topic.
