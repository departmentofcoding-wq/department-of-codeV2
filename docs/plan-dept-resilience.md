# Plan: Department resilience — auto-recover a downed junior/senior, adaptive claude timeout, and scar hardening

**Author:** Claude (dept-of-code-v2-88) · **Implementer:** zai (ZCode/GLM) · **Reviewer:** Claude
**Branch:** `wt/dept-resilience` · **Base:** current local `main` (tip has the `requireActivityStart` fix).

## Goal
The department must run unattended: when the junior (Antigravity) or senior (ZCode)
GUI goes **down or wedged**, the department should **restart it and continue** — not
die fail-closed and wait for a human. Plus: make the claude senior able to work as
long as it needs, and close the scars found in the 2026-08-28 resume.

## Standing invariants (do NOT break)
- No network in tests; temp DBs only; fakes for agents; clean up temp files.
- The **done-gate is absolute** (verifier exit 0 + human approval) — don't touch it.
- Fail-closed philosophy: a partial/aborted agent run is **never** recorded as a verdict.
- Every async step stays a job; attribution/journal unchanged.
- Keep `npm run build` (tsc --noEmit) and `npm test` GREEN. Add real unit tests
  (mutation-proven where there's a guard). No fake/self-filtering tests.

---

## WS1 — Auto-restart a downed SENIOR (ZCode/GLM) and continue
**File:** `engine/harness/senior.ts`

Today `ZCodeSenior.review` (≈ senior.ts:719) throws if `isSeniorPortLive(port)` is
false, telling the operator to relaunch by hand. Make it self-heal.

1. Add `killSeniorProcesses(cfg)` — kill any running ZCode processes. **Scar:** ZCode
   runs a persistent **tray process holding the single-instance lock**, so a plain
   relaunch won't attach the debug port; you must kill ALL ZCode processes first.
   Windows: `taskkill /IM <exeName> /F` (derive exe name from `cfg.cdp`). Make it
   best-effort (ignore "not found").
2. Add `ensureSeniorRunning(cfg, opts?: { timeoutMs?: number })` mirroring
   `ensureJuniorRunning` (antigravity.ts:164): if `isSeniorPortLive(cfg.cdpPort)` →
   return (reuse). Else `killSeniorProcesses(cfg)`, spawn `cfg.cdp` with
   `--remote-debugging-port=<cdpPort>` (detached, unref), then poll
   `isSeniorPortLive` until live or deadline (~40s). Throw only if it never comes up.
3. In `ZCodeSenior.review`, replace the throw-if-not-live with
   `await ensureSeniorRunning(this.cfg)`.
4. **Mid-review death:** wrap the attach→newConversation→sendPrompt→wait sequence so
   that a CDP **connection error** (socket closed / attach failure — NOT a captured
   home-screen, which stays fail-closed) triggers **one** `ensureSeniorRunning` +
   retry. A second failure throws. Do not retry on `detectUncapturedReview` (that's a
   real capture problem, not a down instance).

**Acceptance:** unit tests for the pure/wrappable parts — `ensureSeniorRunning`
returns early when the port is live (inject a fake `isSeniorPortLive`); the mid-review
retry wrapper relaunches exactly once on a connection error and not at all on a
home-screen capture. A live check (manual, documented): with ZCode killed,
`run_senior --senior zai` auto-launches it and returns a verdict.

---

## WS2 — Auto-restart a downed/WEDGED JUNIOR (Antigravity) and continue
**Files:** `engine/harness/antigravity.ts`, `engine/harness/dispatch-job.ts`

The real junior failure (dead job `8c6f373e`) is a **wedged** instance: the port is
live but "opened a window … but no CDP window titled `<taskId> - Antigravity IDE`
appeared within timeout." `ensureJuniorRunning` returns early when the port is live,
so it never fixes a wedge, and `junior.dispatch` burns its 3 attempts without ever
relaunching.

1. Add `killJuniorProcesses(cfg)` (same shape as WS1's senior kill).
2. Add `recoverJuniorRunning(cfg, opts?)` = `killJuniorProcesses` + launch +
   wait-for-port (a FORCED clean relaunch, unlike `ensureJuniorRunning` which no-ops
   when the port is live).
3. In the junior dispatch path (`dispatch-job.ts`), on the wedged-window failure
   ("no CDP window … appeared" / "workbench did not become available"), call
   `recoverJuniorRunning` and retry the window-open **once** within the same dispatch
   before failing the attempt — so a wedged GUI is healed in-flight instead of
   burning all attempts on the same dead instance.

**Acceptance:** unit tests: `recoverJuniorRunning` always kills+relaunches even when
the port is live (inject fakes for kill/spawn/port-check); the dispatch recovery
wrapper relaunches once on the wedged-window error then succeeds on the retry (fake
driver). No live Antigravity needed for the tests.

---

## WS3 — Claude senior timeout: adaptive, so it can work fully
**File:** `engine/harness/senior.ts` (`ClaudeCliSenior.spawnClaude`, ≈311)

Today a single absolute `setTimeout(kill, resolveClaudeSeniorTimeoutMs())` (20 min)
kills claude even while it is actively producing output — cutting off long-but-legit
reviews. Make it **activity-based**, mirroring the zai side's philosophy (no total cap
on an actively-working agent, only a stall window).

1. Replace the single absolute timer with an **inactivity (stall) timer that resets
   on every `stdout`/`stderr` `data` event**. New env `CLAUDE_SENIOR_STALL_MS`
   (default `300000` = 5 min of NO output → stall → kill + reject).
2. Keep a generous **absolute safety cap** `CLAUDE_SENIOR_MAX_MS`
   (default `3600000` = 1h; keep reading `CLAUDE_SENIOR_TIMEOUT_MS` for back-compat as
   the cap's source if set) so a pathological loop still terminates.
3. On stall or cap → `killTree()` + reject with a clear message; partial output is
   **not** returned as a verdict. On natural `close` → resolve (unchanged).
4. Extract the timing logic into a small testable unit (e.g. a
   `makeInactivityGuard({ stallMs, maxMs, onGiveUp })` returning `{ touch, done }`)
   so it can be unit-tested without spawning a real subprocess.

**Acceptance:** unit tests on the extracted guard: streaming keeps it alive past the
stall window as long as `touch()` is called; going quiet for `stallMs` fires
`onGiveUp('stall')`; exceeding `maxMs` fires `onGiveUp('cap')` even while streaming.

---

## WS4 — Close the scars found during the 2026-08-28 resume

### 4a. Stale ZCode home-screen markers (`SENIOR_HOME_SCREEN_MARKERS`, senior.ts:127)
`Full access` and `Add context` are **persistent composer chrome in ZCode 3.9.2**
(visible during an active conversation), so `detectUncapturedReview` can false-positive
on a genuine review that happens to lack a clean `VERDICT:` line. Retighten the marker
set to signals that appear **only on the empty/new-conversation screen** in 3.9.2
(verify against the live DOM; e.g. the new-task/"What can I help"/template-card text —
confirm, don't guess). Keep the guard fail-closed and keep the "≥2 markers AND no
VERDICT line" rule. Update/extend the `detectUncapturedReview` unit tests so a real
review containing the word "Full access" once is NOT rejected, while a true empty-home
capture still is.

### 4b. Single-ZCode-instance mutex (multi-driver contention)
Two drivers hitting the one ZCode instance collide — a second `newConversation()`
resets the first's in-flight review (this broke the live resume). Add a lightweight
**cross-process lock** so only one driver uses ZCode at a time: a lockfile (PID +
acquired-at timestamp, with stale-lock takeover after a TTL) or a `bureau_meta` lease.
`ZCodeSenior.review` (and any ad-hoc ZCode drive) acquires it before attaching and
releases in `finally`. If held by a live holder, wait briefly then fail-fast with a
clear "ZCode busy" message rather than colliding.

**Acceptance:** unit test the lock: acquire → second acquire blocked/So-fails →
release → re-acquire succeeds; a stale lock (old timestamp / dead PID) is taken over.

### 4c. (Docs only) Stale-runner warning
Add a one-paragraph note to `docs/senior-integration.md` (or `antigravity-integration.md`)
that a merged harness fix requires **relaunching the runner AND the console** to take
effect (the console mints a new token on restart). No code required.

---

## Deliverables / definition of done (for zai)
- All WS1–WS4 implemented on `wt/dept-resilience`.
- `npm run build` clean; `npm test` green (report the exact file/test counts).
- New unit tests per the acceptance criteria above (real, no network, temp paths).
- A short `docs/walkthrough-dept-resilience.md` listing: what changed per WS, the new
  env vars + defaults, the tests added, and any live checks you ran.
- Commit to `wt/dept-resilience` with clear per-WS messages. Do NOT merge to main —
  the reviewer (Claude) reviews the branch, then the operator merges.

## Working rules for zai
- Do ALL work inside the worktree folder you are given (a checkout of
  `wt/dept-resilience`). Run every git/npm command there. Do **not** edit the main
  working tree at `D:\Dept of code v2` directly.
- Read the real code before changing it; match surrounding style.
- If a live check needs ZCode/Antigravity, note it as a manual check — don't block the
  code+unit-test deliverable on GUI availability.
