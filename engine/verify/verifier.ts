import { spawn } from 'node:child_process';
import type { BureauTaskRow, DbConnection, VerifyStageResult } from '../contract/index.ts';
import { BUDGET_META_KEYS, VACUOUS_VERIFY_COMMANDS, VERIFY_STAGES, type VerifyStage } from '../contract/constants.ts';
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

/** A staged verify run: the aggregate VerifyRunResult (exit 0 iff every
 *  non-skipped stage passed) plus the per-stage breakdown and full-suite pass
 *  counts (A3). */
export interface StagedVerifyResult extends VerifyRunResult {
  stages: VerifyStageResult[];
  passBefore: number | null;
  passAfter: number | null;
}

const MAX_TAIL_BYTES = 4096;
/** Timeout exit code recorded for a timed-out stage (128 + SIGKILL(9)). */
const TIMEOUT_EXIT_CODE = 137;

function appendTail(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= MAX_TAIL_BYTES) {
    return combined;
  }
  return combined.slice(combined.length - MAX_TAIL_BYTES);
}

function resolveTimeout(db: DbConnection, override?: number): number {
  if (override !== undefined) return override;
  const metaRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    BUDGET_META_KEYS.VERIFY_TIMEOUT_MS
  );
  const rawTimeout = metaRow ? parseInt(metaRow.value, 10) : 120000;
  return Number.isFinite(rawTimeout) ? rawTimeout : 120000;
}

function isVacuous(cmd: string): boolean {
  return VACUOUS_VERIFY_COMMANDS.includes(cmd.toLowerCase() as any);
}

/**
 * Run a single command in the workspace with a scrubbed env, timeout, and
 * tree-kill. The low-level primitive shared by the single-command `runVerifier`
 * and the staged `runStagedVerifier`. No DB, no vacuous check — the callers own
 * policy; this owns execution.
 */
export function runCommand(
  cmd: string,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<VerifyRunResult> {
  const startTime = Date.now();

  return new Promise<VerifyRunResult>((resolve) => {
    let stdoutRaw = '';
    let stderrRaw = '';
    let timedOut = false;
    let finished = false;

    const child = spawn(cmd, [], { cwd: workspacePath, env, shell: true });

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
      resolve({
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startTime,
        stdoutTail: redactOutput(stdoutRaw),
        stderrTail: redactOutput(appendTail(stderrRaw, `\nExecution error: ${err.message}`))
      });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      resolve({
        exitCode: timedOut ? null : code,
        signal: timedOut ? 'SIGKILL' : signal,
        timedOut,
        durationMs: Date.now() - startTime,
        stdoutTail: redactOutput(stdoutRaw),
        stderrTail: redactOutput(stderrRaw)
      });
    });
  });
}

/**
 * Single-command verifier — reads verify_cmd strictly from the DB row, refuses
 * vacuous commands, resolves the timeout, and runs it. Behavior preserved for
 * direct callers (T22/T23/T50); the job path now uses `runStagedVerifier`.
 */
export async function runVerifier(
  db: DbConnection,
  taskId: string,
  workspacePath: string,
  options?: { timeoutMs?: number }
): Promise<VerifyRunResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for verification`);
  }

  const rawCmd = task.verify_cmd?.trim();
  if (!rawCmd) {
    throw new Error(`Task ${taskId} has no verify_cmd configured`);
  }
  if (isVacuous(rawCmd)) {
    throw new Error(`Task ${taskId} verify_cmd '${rawCmd}' is vacuous and refused`);
  }

  return runCommand(rawCmd, workspacePath, scrubEnv(process.env), resolveTimeout(db, options?.timeoutMs));
}

/** Best-effort passing-test count from a stage's output (vitest-style
 *  "<n> passed" — takes the last such number). Null when unparseable, which is
 *  honest: absence of a count is not zero. */
export function parsePassCount(output: string): number | null {
  let last: number | null = null;
  const re = /(\d+)\s+passed/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    last = parseInt(m[1], 10);
  }
  return last;
}

/**
 * Staged verifier (A3). Runs, in the frozen VERIFY_STAGES order, the commands
 * the task/department actually configured:
 *   - structural   → bureau_meta 'verify:structural_cmd' (optional)
 *   - fail-to-pass → task.acceptance_tests (optional; the tests that prove
 *                    acceptance)
 *   - pass-to-pass → task.verify_cmd (REQUIRED; the full suite)
 * Stages with no configured command are recorded skipped (exit 0, never
 * failing). The run short-circuits on the first failing stage. The aggregate
 * exit code is 0 iff every non-skipped stage exited 0 — the unchanged kernel
 * contract. The pass-to-pass stage records pass_after (this run) and pass_before
 * (the prior run's pass_after for this task) so the ledger can show regressions.
 */
export async function runStagedVerifier(
  db: DbConnection,
  taskId: string,
  workspacePath: string,
  options?: { timeoutMs?: number }
): Promise<StagedVerifyResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for verification`);
  }
  const fullCmd = task.verify_cmd?.trim();
  if (!fullCmd) {
    throw new Error(`Task ${taskId} has no verify_cmd configured`);
  }

  const structuralRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    BUDGET_META_KEYS.VERIFY_STRUCTURAL_CMD
  );
  const stageCmds: Record<VerifyStage, string | null> = {
    structural: structuralRow?.value?.trim() || null,
    'fail-to-pass': task.acceptance_tests?.trim() || null,
    'pass-to-pass': fullCmd
  };

  const timeoutMs = resolveTimeout(db, options?.timeoutMs);
  const env = scrubEnv(process.env);

  const stages: VerifyStageResult[] = [];
  let aggStdout = '';
  let aggStderr = '';
  let totalMs = 0;
  let failing: VerifyRunResult | null = null;
  let passBefore: number | null = null;
  let passAfter: number | null = null;

  for (const stage of VERIFY_STAGES) {
    const cmd = stageCmds[stage];
    if (!cmd) {
      stages.push({ stage, exit_code: 0, duration_ms: 0, skipped: true });
      continue;
    }
    // A vacuous stage command greenwashes the gate — refuse it, as the
    // single-command path does for verify_cmd.
    if (isVacuous(cmd)) {
      throw new Error(`Task ${taskId} ${stage} command '${cmd}' is vacuous and refused`);
    }

    const res = await runCommand(cmd, workspacePath, env, timeoutMs);
    totalMs += res.durationMs;
    aggStdout = appendTail(aggStdout, `\n== ${stage} ==\n${res.stdoutTail}`);
    if (res.stderrTail) aggStderr = appendTail(aggStderr, `\n== ${stage} ==\n${res.stderrTail}`);

    const stageOk = res.exitCode === 0 && !res.timedOut;
    stages.push({
      stage,
      exit_code: res.timedOut ? TIMEOUT_EXIT_CODE : res.exitCode ?? 1,
      duration_ms: res.durationMs,
      ...(res.timedOut ? { detail: 'timed out' } : {})
    });

    if (stage === 'pass-to-pass') {
      passAfter = parsePassCount(`${res.stdoutTail}\n${res.stderrTail}`);
      const prior = db.get<{ pass_after: number | null }>(
        `SELECT pass_after FROM bureau_verify_runs
          WHERE task_id = ? AND pass_after IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1`,
        taskId
      );
      passBefore = prior?.pass_after ?? null;
    }

    if (!stageOk) {
      failing = res;
      break; // short-circuit: later stages are not run
    }
  }

  return {
    exitCode: failing ? (failing.timedOut ? null : failing.exitCode) : 0,
    signal: failing ? failing.signal : null,
    timedOut: failing ? failing.timedOut : false,
    durationMs: totalMs,
    stdoutTail: aggStdout.trim(),
    stderrTail: aggStderr.trim(),
    stages,
    passBefore,
    passAfter
  };
}
