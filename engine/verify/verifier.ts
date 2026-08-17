import { spawn } from 'node:child_process';
import type { BureauTaskRow, DbConnection } from '../contract/index.ts';
import { VACUOUS_VERIFY_COMMANDS } from '../contract/constants.ts';
import { redactOutput, scrubEnv } from '../contract/tools.ts';
import { killTree } from './tree_kill.ts';

export interface VerifyRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

const MAX_TAIL_BYTES = 4096;

function appendTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= MAX_TAIL_BYTES) {
    return combined;
  }
  return combined.slice(combined.length - MAX_TAIL_BYTES);
}

export async function runVerifier(
  db: DbConnection,
  taskId: string,
  workspacePath: string,
  options?: { timeoutMs?: number }
): Promise<VerifyRunResult> {
  // Verifier reads verify_cmd strictly from bureau_tasks row in DB
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for verification`);
  }

  const rawCmd = task.verify_cmd?.trim();
  if (!rawCmd) {
    throw new Error(`Task ${taskId} has no verify_cmd configured`);
  }

  if (VACUOUS_VERIFY_COMMANDS.includes(rawCmd.toLowerCase() as any)) {
    throw new Error(`Task ${taskId} verify_cmd '${rawCmd}' is vacuous and refused`);
  }

  // Resolve timeout (option override > bureau_meta key > fallback 120000ms)
  let timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined) {
    const metaRow = db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      'verify:timeout_ms'
    );
    timeoutMs = metaRow ? parseInt(metaRow.value, 10) : 120000;
  }

  const scrubbedEnv = scrubEnv(process.env);
  const startTime = Date.now();

  return new Promise<VerifyRunResult>((resolve) => {
    let stdoutRaw = '';
    let stderrRaw = '';
    let timedOut = false;
    let finished = false;

    // Execute via shell
    const child = spawn(rawCmd, [], {
      cwd: workspacePath,
      env: scrubbedEnv,
      shell: true
    });

    const timeoutTimer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        killTree(child.pid);
      }
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        stdoutRaw = appendTail(stdoutRaw, data.toString('utf-8'));
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        stderrRaw = appendTail(stderrRaw, data.toString('utf-8'));
      });
    }

    child.on('error', (err: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs,
        stdoutTail: redactOutput(stdoutRaw),
        stderrTail: redactOutput(appendTail(stderrRaw, `\nExecution error: ${err.message}`))
      });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: timedOut ? null : code,
        signal: timedOut ? 'SIGKILL' : signal,
        timedOut,
        durationMs,
        stdoutTail: redactOutput(stdoutRaw),
        stderrTail: redactOutput(stderrRaw)
      });
    });
  });
}
