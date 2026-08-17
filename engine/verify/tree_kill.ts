import { execFileSync } from 'node:child_process';

/**
 * Terminate a process and all its child processes in a cross-platform manner.
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // Process already exited or taskkill returned non-zero
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already dead
    }
  }
}
