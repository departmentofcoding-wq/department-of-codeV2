import {
  type BureauDispatchRow,
  type BureauJobRow,
  type BureauOwnershipRow,
  type BureauTaskRow,
  type BureauWindowLeaseRow,
  type DbConnection,
  type JobContext,
  type WatchdogFinding
} from '../contract/index.ts';
import { WATCHDOG_ATTRIBUTION } from '../contract/constants.ts';
import { enqueueJobIfAbsent } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import {
  FINDING_CLASS_DEADLETTER_RETRIES_REMAINING,
  FINDING_CLASS_DISPATCH_NO_LIVE_LEASE,
  FINDING_CLASS_EXPIRED_LEASE_UNREAPED,
  FINDING_CLASS_VERIFYING_NO_VERIFY_RUN
} from './constants.ts';

export interface FindingCandidate {
  subjectKind: string;
  subjectId: string;
  findingClass: string;
  taskId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Scans the database for stranded conditions across 4 classes and records
 * findings idempotently in bureau_watchdog_findings with journaled spans.
 *
 * Strictly READ-ONLY with respect to task and job state tables (bureau_tasks,
 * bureau_jobs).
 */
export function detectWatchdogFindings(
  db: DbConnection,
  options?: { jobId?: string | null }
): WatchdogFinding[] {
  const now = new Date().toISOString();
  const candidates: FindingCandidate[] = [];

  // --- Class 1: verifying_no_verify_run ---
  // Tasks in 'verifying' state with no pending/running verify.run job and at least one completed job
  const verifyingTasks = db.all<BureauTaskRow>(
    `SELECT * FROM bureau_tasks WHERE state = 'verifying'`
  );

  for (const task of verifyingTasks) {
    const activeVerifyJob = db.get<BureauJobRow>(
      `SELECT * FROM bureau_jobs
       WHERE kind = 'verify.run'
         AND task_id = ?
         AND state IN ('pending', 'running')`,
      task.id
    );

    if (!activeVerifyJob) {
      const completedJob = db.get<BureauJobRow>(
        `SELECT * FROM bureau_jobs
         WHERE task_id = ?
           AND state IN ('done', 'failed', 'dead')`,
        task.id
      );

      if (completedJob) {
        candidates.push({
          subjectKind: 'task',
          subjectId: task.id,
          findingClass: FINDING_CLASS_VERIFYING_NO_VERIFY_RUN,
          taskId: task.id,
          detail: {
            task_state: task.state,
            last_completed_job_id: completedJob.id
          }
        });
      }
    }
  }

  // --- Class 2: expired_lease_unreaped ---
  // Active window leases past expires_at with no pending/running lease.reap job
  const expiredLeases = db.all<BureauWindowLeaseRow>(
    `SELECT * FROM bureau_window_leases WHERE status = 'active' AND expires_at <= ?`,
    now
  );

  if (expiredLeases.length > 0) {
    const activeReapJob = db.get<BureauJobRow>(
      `SELECT * FROM bureau_jobs WHERE kind = 'lease.reap' AND state IN ('pending', 'running')`
    );

    if (!activeReapJob) {
      for (const lease of expiredLeases) {
        // Try resolving task_id from dispatch
        const dispatch = db.get<BureauDispatchRow>(
          `SELECT task_id FROM bureau_dispatches WHERE id = ?`,
          lease.dispatch_id
        );

        candidates.push({
          subjectKind: 'lease',
          subjectId: lease.id,
          findingClass: FINDING_CLASS_EXPIRED_LEASE_UNREAPED,
          taskId: dispatch?.task_id ?? null,
          detail: {
            window_target: lease.window_target,
            dispatch_id: lease.dispatch_id,
            expires_at: lease.expires_at
          }
        });
      }
    }
  }

  // --- Class 3: deadletter_retries_remaining ---
  // Jobs marked dead-lettered with retries remaining
  const deadletterJobs = db.all<BureauJobRow>(
    `SELECT * FROM bureau_jobs WHERE state = 'dead' AND attempts < max_attempts`
  );

  for (const job of deadletterJobs) {
    candidates.push({
      subjectKind: 'job',
      subjectId: job.id,
      findingClass: FINDING_CLASS_DEADLETTER_RETRIES_REMAINING,
      taskId: job.task_id ?? null,
      detail: {
        job_kind: job.kind,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        last_error: job.last_error
      }
    });
  }

  // --- Class 4: dispatch_no_live_lease ---
  // bureau_dispatches rows in pending/running with no active window lease or ownership lease
  const activeDispatches = db.all<BureauDispatchRow>(
    `SELECT * FROM bureau_dispatches WHERE status IN ('pending', 'running')`
  );

  for (const dispatch of activeDispatches) {
    const activeLease = db.get<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases
       WHERE dispatch_id = ?
         AND status = 'active'
         AND expires_at > ?`,
      dispatch.id,
      now
    );

    const activeOwnership = db.get<BureauOwnershipRow>(
      `SELECT * FROM bureau_ownership
       WHERE holder_id = ?
         AND expires_at > ?`,
      dispatch.id,
      now
    );

    if (!activeLease && !activeOwnership) {
      candidates.push({
        subjectKind: 'dispatch',
        subjectId: dispatch.id,
        findingClass: FINDING_CLASS_DISPATCH_NO_LIVE_LEASE,
        taskId: dispatch.task_id,
        detail: {
          dispatch_status: dispatch.status,
          work_uuid: dispatch.work_uuid
        }
      });
    }
  }

  // --- Insert Candidates Idempotently & Record Journal Spans ---
  const createdFindings: WatchdogFinding[] = [];

  for (const candidate of candidates) {
    const findingId = crypto.randomUUID();
    const detailStr = JSON.stringify(candidate.detail ?? {});

    const inserted = db.execTransaction(() => {
      const res = db.run(
        `INSERT OR IGNORE INTO bureau_watchdog_findings
         (id, task_id, subject_kind, subject_id, finding_class, status, recover_attempts, detail, detected_at)
         VALUES (?, ?, ?, ?, ?, 'detected', 0, ?, ?)`,
        findingId,
        candidate.taskId ?? null,
        candidate.subjectKind,
        candidate.subjectId,
        candidate.findingClass,
        detailStr,
        now
      );

      if (res.changes > 0) {
        journal(db, {
          kind: 'system',
          attribution: WATCHDOG_ATTRIBUTION,
          taskId: candidate.taskId ?? null,
          jobId: options?.jobId ?? null,
          detail: {
            action: 'watchdog_finding_detected',
            finding_id: findingId,
            finding_class: candidate.findingClass,
            subject_kind: candidate.subjectKind,
            subject_id: candidate.subjectId
          }
        });
        return true;
      }
      return false;
    });

    if (inserted) {
      const finding = db.get<WatchdogFinding>(
        `SELECT * FROM bureau_watchdog_findings WHERE id = ?`,
        findingId
      );
      if (finding) {
        createdFindings.push(finding);
      }
    }
  }

  return createdFindings;
}

export async function handleWatchdogSweep(ctx: JobContext): Promise<void> {
  const cadenceMs = (ctx.payload?.cadenceMs as number) ?? 30000;

  // 1. Run detection scan
  detectWatchdogFindings(ctx.db, { jobId: ctx.job.id });

  // 2. Re-enqueue watchdog.sweep on bounded cadence (no setInterval)
  enqueueJobIfAbsent(ctx.db, {
    id: 'watchdog:sweep:next',
    kind: 'watchdog.sweep',
    payload: { cadenceMs },
    run_after: new Date(Date.now() + cadenceMs).toISOString()
  });
}
