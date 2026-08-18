import {
  type JobContext,
  type WatchdogFinding
} from '../contract/index.ts';
import { WATCHDOG_ATTRIBUTION } from '../contract/constants.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import {
  FINDING_CLASS_DEADLETTER_RETRIES_REMAINING,
  FINDING_CLASS_DISPATCH_NO_LIVE_LEASE,
  FINDING_CLASS_EXPIRED_LEASE_UNREAPED,
  FINDING_CLASS_VERIFYING_NO_VERIFY_RUN
} from './constants.ts';

export interface WatchdogRecoverPayload {
  findingId: string;
}

export const MAX_RECOVER_ATTEMPTS = 3;

export async function handleWatchdogRecover(ctx: JobContext): Promise<void> {
  const payload = ctx.payload as WatchdogRecoverPayload;
  if (!payload || !payload.findingId) {
    throw new Error(`watchdog.recover missing required payload 'findingId'`);
  }

  const finding = ctx.db.get<WatchdogFinding>(
    `SELECT * FROM bureau_watchdog_findings WHERE id = ?`,
    payload.findingId
  );

  if (!finding) {
    throw new Error(`Watchdog finding ${payload.findingId} not found`);
  }

  // Budget Ceiling Check: If recover_attempts has reached ceiling, halt runaway loop
  if (finding.recover_attempts >= MAX_RECOVER_ATTEMPTS) {
    ctx.db.execTransaction(() => {
      ctx.db.run(
        `UPDATE bureau_watchdog_findings SET status = 'failed' WHERE id = ?`,
        finding.id
      );
      journal(ctx.db, {
        kind: 'guardrail',
        attribution: WATCHDOG_ATTRIBUTION,
        taskId: finding.task_id,
        jobId: ctx.job.id,
        detail: {
          action: 'watchdog_recovery_ceiling_exceeded',
          finding_id: finding.id,
          recover_attempts: finding.recover_attempts,
          ceiling: MAX_RECOVER_ATTEMPTS,
          operator_notified: true
        }
      });
    });
    return;
  }

  // Transactionally perform recovery action & increment recover_attempts
  ctx.db.execTransaction(() => {
    // 1. Increment recover_attempts and set recovery_job_id & status
    ctx.db.run(
      `UPDATE bureau_watchdog_findings
       SET recover_attempts = recover_attempts + 1,
           recovery_job_id = ?,
           status = 'recovering'
       WHERE id = ?`,
      ctx.job.id,
      finding.id
    );

    if (finding.task_id) {
      ctx.db.run(
        `UPDATE bureau_tasks
         SET recover_attempts = recover_attempts + 1
         WHERE id = ?`,
        finding.task_id
      );
    }

    // 2. Perform exact bounded action based on finding class
    switch (finding.finding_class) {
      case FINDING_CLASS_VERIFYING_NO_VERIFY_RUN: {
        if (!finding.task_id) {
          throw new Error(`Finding ${finding.id} missing task_id for verify.run recovery`);
        }
        enqueueJob(ctx.db, {
          kind: 'verify.run',
          task_id: finding.task_id,
          payload: { taskId: finding.task_id }
        });
        break;
      }

      case FINDING_CLASS_EXPIRED_LEASE_UNREAPED: {
        enqueueJob(ctx.db, {
          kind: 'lease.reap',
          payload: {}
        });
        break;
      }

      case FINDING_CLASS_DEADLETTER_RETRIES_REMAINING: {
        journal(ctx.db, {
          kind: 'guardrail',
          attribution: WATCHDOG_ATTRIBUTION,
          taskId: finding.task_id,
          jobId: ctx.job.id,
          detail: {
            action: 'watchdog_operator_notified',
            finding_id: finding.id,
            reason: 'deadletter_job_retries_remaining',
            operator_notified: true
          }
        });
        ctx.db.run(
          `UPDATE bureau_watchdog_findings SET status = 'resolved', resolved_at = ? WHERE id = ?`,
          new Date().toISOString(),
          finding.id
        );
        break;
      }

      case FINDING_CLASS_DISPATCH_NO_LIVE_LEASE: {
        journal(ctx.db, {
          kind: 'guardrail',
          attribution: WATCHDOG_ATTRIBUTION,
          taskId: finding.task_id,
          jobId: ctx.job.id,
          detail: {
            action: 'watchdog_operator_notified',
            finding_id: finding.id,
            reason: 'dispatch_no_live_lease',
            operator_notified: true
          }
        });
        ctx.db.run(
          `UPDATE bureau_watchdog_findings SET status = 'resolved', resolved_at = ? WHERE id = ?`,
          new Date().toISOString(),
          finding.id
        );
        break;
      }

      default:
        throw new Error(`Unsupported watchdog finding class '${finding.finding_class}'`);
    }

    journal(ctx.db, {
      kind: 'system',
      attribution: WATCHDOG_ATTRIBUTION,
      taskId: finding.task_id,
      jobId: ctx.job.id,
      detail: {
        action: 'watchdog_recover_executed',
        finding_id: finding.id,
        finding_class: finding.finding_class,
        recover_attempts: finding.recover_attempts + 1
      }
    });
  });
}
