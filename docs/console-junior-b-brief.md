# Junior B — Operator Console Stream B Brief: Frontend + Desktop Launcher

**To:** Junior Engineer B
**From:** Operator
**Branch:** `wt/junior-b-console` (cut from post-D0-C `main`, `11cfdaa`)
**Theme:** the operator's window and one-click launch — legible, safe, and shipped from a desktop shortcut.

---

## 0. Before you write a line of code

1. Read `AGENTS.md`, `docs/DEPARTMENT_STATUS.md`, then `docs/console-plan.md`
   (your stream is Stream B) and the **Security posture** section.
2. `git log --oneline -10` and `git status`. Confirm `main` contains **D0-C**
   (`console/contract.ts`). If not, stop and tell the Operator.
3. `npx vitest run` and `npm run build` — both green before you branch.
4. Cut `git checkout -b wt/junior-b-console` from `11cfdaa`.

**You build on the frozen D0-C contract.** Import the DTO types from
`console/contract.ts` for your render/fetch code. The only hard contract with
Stream A is the endpoint paths + the `x-console-token` header — both frozen in
D0-C — so you can develop fully against a checked-in fixtures JSON until A2's live
endpoints land. Do not redefine DTOs; a contract change is an Operator mini-freeze.

## 1. Non-negotiable constraints
- **Zero new runtime dependencies** — vanilla browser JS, no framework, no
  bundler, no build step. Assets are served static by A's server.
- **The token is required on every `/api` call** — your `fetch` wrapper attaches
  `x-console-token`; on `401` show a "re-launch" state, never a blank screen.
- **No secret ever rendered** — you only display DTO fields the server already
  redacted; don't add client-side logging of responses.
- **A refusal is not a success** — a fail-closed guardrail response must render
  its reason (a toast/error), never a fake "done".

## 2. The review loop (per milestone, in order)
1. Post a plan (files, views, tests) → wait for Senior review.
2. Implement on `wt/junior-b-console`; commit on the branch, never touch main's tree.
3. Record real mutation evidence in `docs/mutation-evidence-console.md`.
4. Post a walkthrough with re-run `npm run build` + suite output and the exact
   commit hash. **Claims must match reality** — re-run the build every time.
5. Operator merges after a posted verdict citing your hash.

## 3. Milestones

### B1 — UI shell + testable render core
`console/public/index.html` + `styles.css` (theme-aware light/dark, responsive,
no horizontal body scroll) + `app.js`. A nav shell (Dashboard / Tasks / Findings
/ Journal), a `fetch` wrapper that injects `x-console-token` and handles 401, and
auto-refresh polling. **Put all formatting/rendering logic in a pure module
`console/public/render.ts`** (DTO → HTML string) so it is unit-testable without a
browser.

**Tests (T-C4):** render functions produce expected markup from D0-C DTO
fixtures; the token wrapper attaches the header and renders the re-launch state on
401. **Mutation:** break a render field mapping → the fixture test fails.

### B2 — Views wired to the read APIs
Dashboard tiles (state populations, budget spend, verify-fail-rate, guardrail
count), task table, findings list (with `subject_kind`/`subject_id`), journal
timeline. Loading / empty / error states; a visible "last updated" and a pause
control. Develop against `test/fixtures/console_*.json` shaped to the DTOs until
A2 is live.

**Tests (T-C5):** each view renders from a representative DTO fixture including
the empty case; an `ApiErrorResponse` renders the error state, not a blank screen.

### B3 — Action UX + desktop shortcut
Approve button with a confirm dialog; trigger-sweep / trigger-backup buttons;
success/guardrail toasts (a guardrail refusal shows its reason). Then the launch
path:
- **`scripts/console.ts`** — mints the token (`node:crypto`), starts A's server,
  prints and opens `http://127.0.0.1:<port>/?token=…`. Support a `--no-open`
  flag for tests. Wire `npm run console`.
- **`scripts/install_console_shortcut.ps1`** — Windows (the dept runs on win32):
  creates a Desktop **and** Start-Menu `.lnk` via `WScript.Shell` that runs the
  launcher in the repo working dir, with an icon; idempotent (overwrites only its
  own shortcut, writes nothing else). Document `.desktop`/`.command` equivalents
  in a comment; Windows is the shipped path.

**Tests (T-C6):** the launcher mints a well-formed token + URL and does **not**
open a browser under `--no-open`; the shortcut generator run dry (`-WhatIf`)
targets the launcher with the correct working dir and writes nothing outside the
Desktop/Start-Menu paths. **Mutation:** drop the token from the launch URL → the
URL-format test fails.

## 4. Boundaries & coordination
- You own `console/public/**`, `scripts/console.ts`, and the shortcut script.
  Junior A owns `console/server.ts` + endpoints. Keep `package.json` edits to
  your own scripts; whoever merges second rebases.
- Tests use ephemeral ports and temp paths; the shortcut test must not write to
  the real Desktop (dry-run only).

## 5. Definition of done for Stream B
B1–B3 merged with posted Senior verdicts; suite + build green on `main`;
T-C4–T-C6 green twice; `npm run console` opens a working panel and the desktop
shortcut launches it; mutation evidence recorded and reproducible; the ledger
updated by the Operator at each merge.
