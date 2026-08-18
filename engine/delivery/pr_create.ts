import { execSync } from 'node:child_process';
import type { AttributionTuple, BureauTaskRow, BureauWorkReviewRow, JobContext } from '../contract/types.ts';
import { getPrProvider } from '../contract/pr-seam.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { DeliveryError } from './types.ts';
import { DEFAULT_PR_BASE_BRANCH, REVIEW_PR_META_KEYS } from '../contract/constants.ts';

const SYSTEM_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

export async function handlePrCreate(ctx: JobContext): Promise<void> {
  const { db, payload } = ctx;
  const taskId = payload.taskId || ctx.job.task_id;
  if (!taskId) {
    throw new DeliveryError('pr.create job missing taskId in payload or job row', 'MISSING_TASK_ID');
  }

  // 1. Read task state & work reviews
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new DeliveryError(`Task ${taskId} not found`, 'TASK_NOT_FOUND', taskId);
  }

  let refusalReason: string | null = null;

  if (task.state !== 'needs-review') {
    refusalReason = `Task ${taskId} is in state ${task.state} (must be needs-review)`;
  } else if (task.verifier_exit_code !== 0) {
    refusalReason = `Task ${taskId} verifier_exit_code is ${task.verifier_exit_code} (must be 0)`;
  } else if (!task.approved_at || !task.approved_by) {
    refusalReason = `Task ${taskId} lacks recorded operator approval (approved_at/approved_by missing)`;
  }

  let currentTip = '';
  if (!refusalReason) {
    try {
      const handle = await getWorkspaceProvider().getWorkspaceHandle(db, taskId);
      currentTip = execSync('git rev-parse HEAD', {
        cwd: handle.path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (err: any) {
      refusalReason = `Failed to get worktree commit tip for task ${taskId}: ${err.message}`;
    }
  }

  if (!refusalReason) {
    const latestReview = db.get<BureauWorkReviewRow>(
      'SELECT * FROM bureau_work_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      taskId
    );

    if (!latestReview || latestReview.verdict !== 'approved') {
      refusalReason = `Task ${taskId} lacks an approved work review (verdict must be approved)`;
    } else if (!latestReview.reviewed_commit || latestReview.reviewed_commit !== currentTip) {
      refusalReason = `Task ${taskId} work review commit (${latestReview.reviewed_commit}) does not match current branch tip (${currentTip})`;
    }
  }

  // Refusal path: journal guardrail span OUTSIDE transaction and throw
  if (refusalReason) {
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'pr.create', status: 'refused', reason: refusalReason }
    });
    throw new DeliveryError(refusalReason, 'PR_CREATE_REFUSED', taskId);
  }

  // Success path
  const prProvider = getPrProvider();
  const branchName = `bureau-wt-${taskId}`;

  const baseBranchRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.PR_BASE_BRANCH
  );
  const baseBranch = baseBranchRow?.value || DEFAULT_PR_BASE_BRANCH;

  await prProvider.pushBranch(branchName);

  const title = `feat(${taskId}): ${task.title}`;
  const body = `Automated PR for task ${taskId}\n\nReviewed commit: ${currentTip}\n\nIntent: ${task.intent || 'N/A'}`;

  const prResult = await prProvider.createPr({
    branch: branchName,
    title,
    body,
    base: baseBranch
  });

  const now = new Date().toISOString();
  db.run(
    'UPDATE bureau_tasks SET pull_request_url = ?, updated_at = ? WHERE id = ?',
    prResult.url,
    now,
    taskId
  );

  journal(db, {
    kind: 'system',
    attribution: SYSTEM_ATTRIBUTION,
    taskId,
    detail: {
      action: 'pr.create',
      status: 'created',
      url: prResult.url,
      number: prResult.number,
      branch: branchName,
      reviewedCommit: currentTip
    }
  });

  enqueueJob(db, {
    kind: 'pr.merge',
    task_id: taskId,
    payload: { taskId, prNumber: prResult.number }
  });
}
