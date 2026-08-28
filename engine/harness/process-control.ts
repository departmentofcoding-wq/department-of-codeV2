import child_process from 'node:child_process';

/**
 * Best-effort process cleanup for the department's GUI agents (Electron apps:
 * ZCode senior, Antigravity juniors). Shared by the senior and junior harnesses
 * so both recover a downed instance the same way.
 *
 * Scar (2026-08-28 resume): these apps keep a persistent tray/background process
 * holding the SINGLE-INSTANCE lock. A plain relaunch while that process lives
 * just hands off to it and the debug port never comes back, so recovery must
 * kill ALL of the app's processes first (Windows: `taskkill /IM <exe> /F`, which
 * matches every process of that image name). "Process not found" is a fine
 * outcome — the kill is strictly best-effort and never throws.
 */

/** The OS process-image name for a binary path — what `taskkill /IM` wants. Pure. */
export function processImageName(binaryPath: string): string {
  const base = binaryPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || binaryPath;
  return base;
}

/** Build the best-effort "kill every process of this image" command. Pure. */
export function buildKillProcessCommand(exeName: string): string {
  const quoted = `"${exeName}"`;
  return process.platform === 'win32' ? `taskkill /IM ${quoted} /F` : `pkill -x ${quoted}`;
}

/** Kill every running process of the named image, swallowing all errors. */
export async function killProcessesByImageName(exeName: string): Promise<void> {
  await new Promise<void>(resolve => {
    // The callback swallows everything — "not found", access denied, pkill
    // absent. A failed kill surfaces one line later as a launch failure with a
    // clear message, which is the actionable error.
    const child = child_process.exec(buildKillProcessCommand(exeName), () => resolve());
    child.on('error', () => resolve());
  });
}
