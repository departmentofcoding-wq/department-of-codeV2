import type { JobContext, AttributionTuple, BureauJobRow, BureauTaskRow } from '../contract/index.ts';
import { transition } from '../state/machine.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';

const FOREMAN_ATTRIBUTION: AttributionTuple = {
  actor_role: 'foreman',
  provider: 'deterministic',
  model: 'core',
  account: null
};

export async function handleWorktreePrepare(ctx: JobContext): Promise<void> {
  const taskId: string = ctx.payload?.taskId ?? ctx.job.task_id;
  if (!taskId) {
    throw new Error('worktree.prepare job payload or job.task_id must contain taskId');
  }

  // 1. Transition queued -> claimed if task is still queued
  const task = ctx.db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for worktree.prepare`);
  }

  if (task.state === 'queued') {
    transition(ctx.db, taskId, 'claimed', FOREMAN_ATTRIBUTION);
  }

  // 2. Prepare worktree via seam
  const provider = getWorkspaceProvider();
  const handle = await provider.prepare(ctx.db, taskId);

  // 3. Journal the prepare outcome (A-S6)
  journal(ctx.db, {
    kind: 'system',
    attribution: FOREMAN_ATTRIBUTION,
    taskId,
    jobId: ctx.job.id,
    detail: {
      action: 'worktree_prepared',
      path: handle.path,
      baseCommit: handle.baseCommit
    }
  });

  // 4. Idempotent Enqueue Step (A-S2): Check for existing pending/running verify.run job
  const existingVerifyJob = ctx.db.get<BureauJobRow>(
    "SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state IN ('pending', 'running')",
    taskId
  );

  if (!existingVerifyJob) {
    enqueueJob(ctx.db, {
      kind: 'verify.run',
      task_id: taskId,
      payload: { taskId }
    });
  }
}
