import { execSync } from 'node:child_process';
import type { AttributionTuple, BureauTaskRow, BureauWorkReviewRow, JobContext } from '../contract/types.ts';
import { getPrProvider } from '../contract/pr-seam.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';
import { journal } from '../journal/writer.ts';
import { transition } from '../state/machine.ts';
import { notifyOperator } from '../state/notifications.ts';
import { DeliveryError } from './types.ts';
import { formatActor } from '../contract/validation.ts';

const SYSTEM_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

export async function handlePrMerge(ctx: JobContext): Promise<void> {
  const { db, payload } = ctx;
  const taskId = payload.taskId || ctx.job.task_id;
  if (!taskId) {
    throw new DeliveryError('pr.merge job missing taskId in payload or job row', 'MISSING_TASK_ID');
  }

  let prNumber = payload.prNumber;
  if (!prNumber) {
    const task = db.get<BureauTaskRow>('SELECT pull_request_url FROM bureau_tasks WHERE id = ?', taskId);
    if (task?.pull_request_url) {
      const match = task.pull_request_url.match(/\/pull\/(\d+)$/);
      if (match) {
        prNumber = parseInt(match[1], 10);
      }
    }
  }

  if (!prNumber) {
    const reason = `Task ${taskId} has no valid PR number for merge`;
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'pr.merge', status: 'refused', reason }
    });
    throw new DeliveryError(reason, 'NO_PR_NUMBER', taskId);
  }

  let refusalReason: string | null = null;
  const prProvider = getPrProvider();

  try {
    // Write-locked transaction for re-checking tip and updating DB
    await db.execTransaction(async () => {
      const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.state !== 'needs-review') {
        throw new Error(`Task ${taskId} state is ${task.state} (must be needs-review)`);
      }
      if (task.verifier_exit_code !== 0) {
        throw new Error(`Task ${taskId} verifier_exit_code is ${task.verifier_exit_code} (must be 0)`);
      }
      if (!task.approved_at || !task.approved_by) {
        throw new Error(`Task ${taskId} lacks operator approval`);
      }

      let currentTip = '';
      try {
        const handle = await getWorkspaceProvider().getWorkspaceHandle(db, taskId);
        currentTip = execSync('git rev-parse HEAD', {
          cwd: handle.path,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
      } catch (err: any) {
        throw new Error(`Failed to read branch tip commit for task ${taskId}: ${err.message}`);
      }

      const latestReview = db.get<BureauWorkReviewRow>(
        'SELECT * FROM bureau_work_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
        taskId
      );

      if (!latestReview || latestReview.verdict !== 'approved') {
        throw new Error(`Task ${taskId} work review verdict is not approved`);
      }
      if (!latestReview.reviewed_commit || latestReview.reviewed_commit !== currentTip) {
        throw new Error(`Task ${taskId} work review commit (${latestReview.reviewed_commit}) does not match current tip (${currentTip})`);
      }

      // Step B-4 / B-11 ordering:
      // 1. Call prProvider.mergePr (if fails, error thrown and transaction rolls back)
      await prProvider.mergePr(prNumber);

      // 2. Transition state needs-review -> done (writes transition journal span)
      transition(db, taskId, 'done', SYSTEM_ATTRIBUTION, { action: 'merge', prNumber });

      // 3. Update merged_at / merged_by (ordered AFTER state transition per B-11 schema CHECK)
      const now = new Date().toISOString();
      const mergedBy = formatActor(SYSTEM_ATTRIBUTION);
      db.run(
        'UPDATE bureau_tasks SET merged_at = ?, merged_by = ?, updated_at = ? WHERE id = ? AND state = ?',
        now,
        mergedBy,
        now,
        taskId,
        'done'
      );
    });
  } catch (err: any) {
    const refusalMsg = err?.message || String(err);
    // Journal guardrail span OUTSIDE transaction so rollback does not erase it (B-3)
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'pr.merge', status: 'refused', reason: refusalMsg }
    });
    throw new DeliveryError(refusalMsg, 'PR_MERGE_REFUSED', taskId);
  }

  // Step B-4: Prune strictly POST-COMMIT
  try {
    const workspaceProvider = getWorkspaceProvider();
    await workspaceProvider.prune(db, taskId);
  } catch (pruneErr: any) {
    const pruneErrMsg = pruneErr?.message || String(pruneErr);
    const warningMsg = `Post-merge prune failed for task ${taskId}: ${pruneErrMsg}`;
    journal(db, {
      kind: 'system',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'prune', status: 'warning', error: warningMsg }
    });
    notifyOperator(`prune:${taskId}`, warningMsg);
  }
}
