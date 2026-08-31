import { execSync } from 'node:child_process';
import type { AttributionTuple, BureauTaskRow, BureauWorkReviewRow, DbConnection, JobContext } from '../contract/types.ts';
import { getPrProvider } from '../contract/pr-seam.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { DeliveryError, PrRefusalError } from './types.ts';
import { DEFAULT_PR_BASE_BRANCH, REVIEW_PR_META_KEYS } from '../contract/constants.ts';

const SYSTEM_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

export function getBranchTipCommit(db: DbConnection, taskId: string): string {
  const row = db.get<{ path: string }>(
    "SELECT path FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
    taskId
  );
  if (!row || !row.path) {
    throw new Error(`Worktree for task ${taskId} not found`);
  }
  const tip = execSync('git rev-parse HEAD', {
    cwd: row.path,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (!tip) {
    throw new Error(`git rev-parse HEAD returned empty output in ${row.path}`);
  }
  return tip;
}

export async function handlePrCreate(ctx: JobContext): Promise<void> {
  const { db, payload } = ctx;
  const taskId = payload.taskId || ctx.job.task_id;
  if (!taskId) {
    throw new DeliveryError('pr.create job missing taskId in payload or job row', 'MISSING_TASK_ID');
  }

  let task: BureauTaskRow | undefined;
  let currentTip = '';
  let baseBranch = DEFAULT_PR_BASE_BRANCH;

  // Synchronous, atomic transaction for reading task state & validating preconditions
  try {
    db.execTransaction(() => {
      task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.state !== 'needs-review') {
        throw new Error(`Task ${taskId} is in state ${task.state} (must be needs-review)`);
      }
      if (task.verifier_exit_code !== 0) {
        throw new Error(`Task ${taskId} verifier_exit_code is ${task.verifier_exit_code} (must be 0)`);
      }
      if (!task.approved_at || !task.approved_by) {
        throw new Error(`Task ${taskId} lacks recorded operator approval (approved_at/approved_by missing)`);
      }

      currentTip = getBranchTipCommit(db, taskId);

      const latestReview = db.get<BureauWorkReviewRow>(
        'SELECT * FROM bureau_work_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
        taskId
      );

      if (!latestReview || latestReview.verdict !== 'approved') {
        throw new Error(`Task ${taskId} lacks an approved work review (verdict must be approved)`);
      }
      if (!latestReview.reviewed_commit || latestReview.reviewed_commit !== currentTip) {
        throw new Error(`Task ${taskId} work review commit (${latestReview.reviewed_commit}) does not match current branch tip (${currentTip})`);
      }

      const baseBranchRow = db.get<{ value: string }>(
        'SELECT value FROM bureau_meta WHERE key = ?',
        REVIEW_PR_META_KEYS.PR_BASE_BRANCH
      );
      if (baseBranchRow?.value) {
        baseBranch = baseBranchRow.value;
      }
    });
  } catch (err: any) {
    const refusalReason = err.message || String(err);
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'pr.create', status: 'refused', reason: refusalReason }
    });
    // A precondition refusal is deterministic — dead on first failure, never
    // retried (the 2026-08-28 zombie retried "task is done" twice).
    throw new PrRefusalError(refusalReason, 'PR_CREATE_REFUSED', taskId);
  }

  if (!task) {
    throw new DeliveryError(`Task ${taskId} not found after transaction`, 'TASK_NOT_FOUND', taskId);
  }

  // Async PR creation operations outside DB transaction
  const prProvider = getPrProvider();
  const branchName = `bureau-wt-${taskId}`;
  const refspec = `HEAD:refs/heads/${branchName}`;

  const wtRow = db.get<{ path: string }>(
    "SELECT path FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
    taskId
  );

  await prProvider.pushBranch(refspec, wtRow?.path);

  const title = `feat(${taskId}): ${task.title}`;
  const body = `Automated PR for task ${taskId}\n\nReviewed commit: ${currentTip}\n\nIntent: ${task.intent || 'N/A'}`;

  // Run `gh pr create` in the task's worktree so it targets the task's own
  // project repo, not the dept repo (N8). `pushBranch` already threads this
  // path; `createPr` must too, or non-dept deliveries die (see provider note).
  const prResult = await prProvider.createPr({
    branch: branchName,
    title,
    body,
    base: baseBranch
  }, wtRow?.path);

  // Synchronous DB update for PR URL, journal span, and next job enqueue
  db.execTransaction(() => {
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
  });
}
