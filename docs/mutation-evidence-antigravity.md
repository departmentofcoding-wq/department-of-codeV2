# Mutation Evidence — Antigravity Junior Integration

## M-AG1: Debug-port launch arg guard (`engine/harness/antigravity.ts`)

- **Guard Broken**: `buildAntigravityArgs` must pass `--remote-debugging-port=<port>` so the launched Antigravity exposes a CDP endpoint. Without it, the department can never attach.
- **Mutation Applied**: Changed the return to `[]` (no debug-port flag).
- **Test Command**: `npx vitest run test/unit/tc_antigravity.test.ts`
- **Result**: `1 failed | 2 passed` — `AssertionError: expected [] to deeply equal [ '--remote-debugging-port=9333' ]`.
- **Verification**: Restored code passes 3/3.

## Live end-to-end proof (not a unit test — recorded here)

Verified against a running Antigravity 2.8.1 (Electron 41 / Chrome 146):
`node --experimental-strip-types scripts/run_junior.ts --port 9333 "<command>"`
attached to the existing instance, found the workbench window, typed the command
into the "Message input" chat, submitted it, and the agent replied:
> "I confirm that the Department of Code launcher has successfully reached me via code."

## M-AG2: junior.dispatch → Antigravity routing (`engine/harness/dispatch-job.ts`)

- **Guard Broken**: the `if (payload.prompt)` branch routes a dispatch command to the Antigravity driver.
- **Mutation Applied**: `if (false && payload.prompt)` (routing disabled).
- **Test Command**: `npx vitest run test/integration/tc_dispatch_antigravity.test.ts`
- **Result**: `1 failed` — the driver never receives the prompt and no `observation` span is journaled.
- **Verification**: Restored code passes 1/1.

## Live proof — pipeline path
`handleJuniorDispatch` with a `prompt` payload (no override, port 9333) drove the
real Antigravity: dispatch transitioned to `completed` and journaled an
`observation` span with `source: 'antigravity'`. (Transcript read is best-effort
`document.body.innerText` tail — can capture transient menus; robustly targeting
the conversation container is a calibration follow-up.)

## M-AG3: Agent-reply chrome isolation (`engine/harness/antigravity.ts`)

- **Guard Broken**: `isChrome` filtering in `extractAgentReply`, which strips IDE chrome (timestamps, model-name label, input placeholder) from the captured reply.
- **Mutation Applied**: `isChrome` always returns `false` (no chrome stripped).
- **Test Command**: `npx vitest run test/unit/tc_antigravity.test.ts`
- **Result**: `1 failed` — the reply now includes timestamps/chrome instead of just `PIPELINE OK`.
- **Verification**: Restored code passes 7/7.
