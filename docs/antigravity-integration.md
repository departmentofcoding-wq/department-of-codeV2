# Antigravity Junior Integration

How the department drives its **two juniors** — both Antigravity agents — from
code. Antigravity is an Electron/Chromium app (verified live against **2.8.1**,
Electron 41 / Chrome 146), so it speaks the Chrome DevTools Protocol exactly like
the browser the Phase 3 `CdpIdeDriver` already drove. This document is the
operating manual for that seam.

## The two juniors (one per Pro account)

| Id | App | Binary | CDP port | Env override |
|---|---|---|---|---|
| **A** | Antigravity **IDE** (VS Code fork) | `…\Programs\Antigravity IDE\Antigravity IDE.exe` | `9333` | `ANTIGRAVITY_IDE_PATH` |
| **B** | Antigravity **2.0** (standalone agent app; ships `language_server.exe` + `webm_encoder.exe`) | `…\Programs\Antigravity\Antigravity.exe` | `9334` | `ANTIGRAVITY_2_PATH` |

Both are launched with their own `--remote-debugging-port`, so both can be driven
at once, and their two Pro accounts stay separate (different data folders). They
share the **same DOM landmarks** (verified live), so one driver runs both:

- **Chat input:** `contenteditable` with `aria-label="Message input"`.
- **Model picker:** `button[aria-label^="Select model"]` → `[role=menuitem]` options
  (e.g. "Gemini 3.7 Flash", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B").
- **Send:** `aria-label="Send message"` — **2.0 does not submit on Enter**, so
  `sendPrompt` presses Enter *and* clicks Send if the input still holds text.
- **Folder / project:** each workspace is a sidebar button carrying its name/path;
  `selectFolder(nameOrPath)` clicks it.

### Registry & driving

`JUNIORS` (in `antigravity.ts`) holds both configs; `resolveJunior('A'|'B')`
selects one (default `A`). `AntigravitySession` gained `selectModel(name)`,
`selectFolder(nameOrPath)`, and `captureArtifacts(prompt)` (returns
`{ transcript, reply, plan, walkthrough }`).

### Captured as department data

Antigravity emits an **implementation plan** before coding and a **walkthrough**
when done. `extractPlan` / `extractWalkthrough` (pure, marker-based like
`extractAgentReply`) isolate them; `junior.dispatch` writes them plus the whole
output to `docs/junior-artifacts/<taskId>/…/{plan,walkthrough,reply,transcript}.md`
and journals an `observation` span carrying `{ junior, model, folder, hasPlan,
hasWalkthrough, artifactFiles }`. NOTE: the plan/walkthrough heading markers
(`PLAN_MARKERS` / `WALKTHROUGH_MARKERS`) are best-effort until refined against the
first live task that emits them.

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
# Junior A (IDE) — detect-or-open, attach, send a command, print reply/plan/walkthrough:
npm run junior "add a function add(a,b) to math.js with a test"

# Junior B (Antigravity 2.0), selecting model + folder through the GUI first:
node --experimental-strip-types scripts/run_junior.ts --junior B \
  --model "Gemini 3.7 Flash" --folder "Dept of code v2" "refactor foo() for clarity"

# Just check a junior is drivable (no command):
node --experimental-strip-types scripts/run_junior.ts --junior B --status

# Point at an explicit CDP port (bypasses the junior's configured port):
node --experimental-strip-types scripts/run_junior.ts --port 9333 "..."
```

### Through the department pipeline
Enqueue a `junior.dispatch` job whose payload carries a `prompt` (and optional
`antigravityPort`). The handler drives the live agent and records its reply:

```ts
// payload for a junior.dispatch job
{
  dispatchId: '<row id>',
  prompt: 'refactor foo() for clarity',
  junior: 'B',                 // 'A' = IDE (default), 'B' = Antigravity 2.0
  model: 'Gemini 3.7 Flash',   // optional: driven through the GUI picker
  folder: 'Dept of code v2'    // optional: workspace selected in the GUI
}
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
- **Junior-dispatch stall (IDE relaunched without debug port — S6).** On a
  junior-dispatch stall or failure to connect, suspect an Antigravity IDE or
  Antigravity 2.0 instance that was restarted manually or by an auto-update
  without `--remote-debugging-port`. Recovery: kill all Antigravity processes
  (`taskkill /IM "Antigravity.exe" /F` / `taskkill /IM "Antigravity IDE.exe" /F`)
  and relaunch with the appropriate debug flag (`--remote-debugging-port=9333`
  for IDE, `--remote-debugging-port=9334` for 2.0).

## Tests & evidence

- `test/unit/tc_antigravity.test.ts` — pure surface: `buildAntigravityArgs`,
  `findAntigravityBinary` (via `ANTIGRAVITY_PATH`), `isDebugPortLive`,
  `extractAgentReply` (real 2.8.1 shape + fallback).
- `test/integration/tc_dispatch_antigravity.test.ts` — `junior.dispatch` prompt
  routing via a fake driver (dispatch completes + `observation` journaled).
- `docs/mutation-evidence-antigravity.md` — M-AG1 (debug-port arg), M-AG2
  (dispatch routing), plus recorded live end-to-end runs.
