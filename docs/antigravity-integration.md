# Antigravity Junior Integration

How the department drives its **junior** — the Antigravity IDE agent — from code.
Antigravity is an Electron/Chromium app (verified against **2.8.1**, Electron 41 /
Chrome 146), so it speaks the Chrome DevTools Protocol exactly like the browser
the Phase 3 `CdpIdeDriver` already drove. This document is the operating manual
for that seam.

## What it does

- **Detect or open.** Check whether Antigravity is already exposing a CDP
  endpoint; if not, launch it with `--remote-debugging-port` and wait for CDP.
- **Attach.** Connect to the main workbench window over the DevTools WebSocket.
- **Command.** Type a natural-language command into the agent chat and submit it.
- **Read back.** Capture the agent's reply, isolated from IDE chrome.

## Components

| File | Role |
|---|---|
| `engine/harness/antigravity.ts` | Core: `findAntigravityBinary`, `ensureAntigravityRunning` (detect-or-launch), `findMainWindowWs`, `AntigravitySession` (CDP session: `sendPrompt`, `readAgentReply`), and the pure `extractAgentReply`. |
| `engine/harness/antigravity-seam.ts` | Override-able `AntigravityDriver` seam (like `llm-seam`/`pr-seam`). Real impl drives live Antigravity; tests inject a fake. |
| `engine/harness/dispatch-job.ts` | `junior.dispatch` prompt path: a payload with `prompt` routes to the Antigravity driver and journals the reply as an attributed `observation` span. |
| `scripts/run_junior.ts` | CLI (`npm run junior`) — detect/open/attach/command from the terminal. |

## Usage

### CLI
```bash
# Detect-or-open Antigravity, attach, send a command, print the agent's reply:
npm run junior "add a function add(a,b) to math.js with a test"

# Just check the junior is drivable (no command):
node --experimental-strip-types scripts/run_junior.ts --status

# Point at a specific CDP port (default 9333):
node --experimental-strip-types scripts/run_junior.ts --port 9333 "..."
```

### Through the department pipeline
Enqueue a `junior.dispatch` job whose payload carries a `prompt` (and optional
`antigravityPort`). The handler drives the live agent and records its reply:

```ts
// payload for a junior.dispatch job
{ dispatchId: '<row id>', prompt: 'refactor foo() for clarity', antigravityPort: 9333 }
```
The dispatch transitions to `completed` and writes an `observation` span with
`{ source: 'antigravity', prompt, launched, transcriptTail }`.

## Preconditions

- **Antigravity installed.** Auto-located at
  `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe` (or `Antigravity IDE`);
  override with `ANTIGRAVITY_PATH`.
- **CDP port.** Default `9333`. If Antigravity is already running *without* a
  debug port, the launcher opens a new instance with one (Electron requires the
  flag at launch).

## Calibration notes (version-specific — 2.8.1)

- **Chat input:** a `contenteditable` `DIV` whose `aria-label`/`placeholder` is
  `"Message input"` (`ANTIGRAVITY_INPUT_LABEL`).
- **Main window:** matched by its workbench URL prefix `https://127.0.0.1`
  (`ANTIGRAVITY_WORKBENCH_URL_PREFIX`) — **not** the page title, which changes to
  reflect the active chat/workspace.
- **Reply isolation:** `extractAgentReply(fullText, prompt)` is version-resilient
  — it returns the text after the last occurrence of the prompt, dropping bare
  timestamps and trailing chrome (input placeholder, model-name label, effort
  toggles, "View Usage"). It keys off the prompt we sent, not fragile DOM classes,
  so it survives most UI changes. If Antigravity changes the input's aria-label,
  re-calibrate `ANTIGRAVITY_INPUT_LABEL` (that's the one hard selector).

## Rate limits (Google free tier)

The junior's model is chosen in Antigravity's own model picker, and the API key
is a Google/Gemini free-tier key with per-minute/day caps. If the junior stalls
on quota:
- **Switch the model** to one with headroom (the picker button carries the model
  name; on the last check Gemini 2.5/3.7 Flash were green and the *Antigravity
  Agents* tier had 60 RPM). This can be driven from code (open the picker button,
  click the target option) or by hand in the IDE.
- Or **set up billing** to raise the limits.
- The department's own `callModel` (officers) already degrades on HTTP 429 by
  putting the model in cooldown (`GoogleClient` → `setModelCooldown`); it does
  not crash. Rate limits are an operational matter, not a code bug.

## Scars (real incidents, recorded)

- **Parameter properties break the runtime.** `node --experimental-strip-types`
  rejects TS constructor parameter properties (`constructor(private x)`) even
  though `tsc` accepts them. Use explicit field assignment.
- **Window title is not stable.** The workbench page title reflects the active
  chat, so match the main window by its `https://127.0.0.1` URL.
- **Stray menus swallow input.** An open model picker can intercept focus/keys;
  `sendPrompt` presses `Escape` before focusing the chat input.
- **Whole-body text is noisy.** Reading `document.body.innerText` can capture
  menus/panels; `extractAgentReply` slices the reply relative to the sent prompt
  instead.

## Tests & evidence

- `test/unit/tc_antigravity.test.ts` — pure surface: `buildAntigravityArgs`,
  `findAntigravityBinary` (via `ANTIGRAVITY_PATH`), `isDebugPortLive`,
  `extractAgentReply` (real 2.8.1 shape + fallback).
- `test/integration/tc_dispatch_antigravity.test.ts` — `junior.dispatch` prompt
  routing via a fake driver (dispatch completes + `observation` journaled).
- `docs/mutation-evidence-antigravity.md` — M-AG1 (debug-port arg), M-AG2
  (dispatch routing), plus recorded live end-to-end runs.
