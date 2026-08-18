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
