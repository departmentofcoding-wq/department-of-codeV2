import type { BureauTaskRow, JobContext } from '../contract/index.ts';
import { VERIFIER_ATTRIBUTION } from '../contract/constants.ts';
import { formatActor } from '../contract/validation.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';
import { completeJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { transition } from '../state/machine.ts';
import { handleVerifyOutcome } from './loop.ts';
import { runVerifier } from './verifier.ts';

export async function executeVerifyRunJob(ctx: JobContext): Promise<void> {
  const taskId = ctx.payload.taskId ?? ctx.job.task_id;
  if (!taskId) {
    throw new Error(`verify.run job ${ctx.job.id} missing taskId in payload or job row`);
  }

  const task = ctx.db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for verify.run job`);
  }

  // 1. Re-entry tolerant state transition
  if (task.state === 'claimed') {
    transition(ctx.db, taskId, 'verifying', VERIFIER_ATTRIBUTION);
  } else if (task.state === 'verifying') {
    // Resuming after crash mid-child process execution
    journal(ctx.db, {
      kind: 'system',
      attribution: VERIFIER_ATTRIBUTION,
      taskId,
      jobId: ctx.job.id,
      detail: { action: 'verify_resumed', state: task.state }
    });
  } else {
    throw new Error(`Task ${taskId} cannot run verify from state ${task.state} (must be claimed or verifying)`);
  }

  // 2. Resolve workspace handle & clean start-of-verify checkpoint
  const provider = getWorkspaceProvider();
  const workspaceHandle = await provider.getWorkspaceHandle(ctx.db, taskId);
  await provider.checkpoint(ctx.db, taskId, VERIFIER_ATTRIBUTION, 'verify-start-checkpoint');

  const startTime = new Date().toISOString();
  const verifyFixesBefore = task.verify_fixes;

  // 3. Execute child verifier process
  const outcome = await runVerifier(ctx.db, taskId, workspaceHandle.path);
  const finishedTime = new Date().toISOString();

  // 4. Atomic Finalization Transaction
  const runId = crypto.randomUUID();

  ctx.db.execTransaction(() => {
    // Record run row
    ctx.db.run(
      `INSERT INTO bureau_verify_runs (
        id, task_id, exit_code, signal, timed_out, duration_ms,
        verify_fixes_before, stdout_tail, stderr_tail, started_at, finished_at,
        actor_role, provider, model, account
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      taskId,
      outcome.exitCode,
      outcome.signal,
      outcome.timedOut ? 1 : 0,
      outcome.durationMs,
      verifyFixesBefore,
      outcome.stdoutTail,
      outcome.stderrTail,
      startTime,
      finishedTime,
      VERIFIER_ATTRIBUTION.actor_role,
      VERIFIER_ATTRIBUTION.provider,
      VERIFIER_ATTRIBUTION.model,
      VERIFIER_ATTRIBUTION.account
    );

    // Journal verify run span
    journal(ctx.db, {
      kind: 'tool',
      attribution: VERIFIER_ATTRIBUTION,
      taskId,
      jobId: ctx.job.id,
      detail: {
        action: 'verify_run_completed',
        run_id: runId,
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        duration_ms: outcome.durationMs
      }
    });

    // Atomically mark the job done inside finalization transaction (B-2 fix)
    completeJob(ctx.db, ctx.job.id);
  });

  // Execute state transitions & loop logic (including async checkpointing)
  await handleVerifyOutcome(ctx.db, taskId, outcome, VERIFIER_ATTRIBUTION);
}

