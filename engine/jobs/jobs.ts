import {
  type AttributionTuple,
  type BureauJobRow,
  type DbConnection,
  DETERMINISTIC_ATTRIBUTION
} from '../contract/index.ts';
import { journal } from '../journal/writer.ts';

/**
 * The attribution every deterministic runner/reaper act records: software did
 * this, no model was consulted. Span-level detail still says which action.
 */
export const FOREMAN_ATTRIBUTION: AttributionTuple = {
  actor_role: 'foreman',
  ...DETERMINISTIC_ATTRIBUTION
};

/**
 * A deterministic refusal the retry loop can never outwait: invalid input,
 * a violated precondition, a wrong state. Throwing this (or setting
 * `nonRetryable = true` on a domain error) makes the job DEAD on its first
 * failure instead of burning every attempt — the 2026-08-29 scar burned 3
 * attempts × 2 guardrail spans re-refusing the same invalid slug, and the
 * 2026-08-28 zombie pr.create retried "task is done" twice after the work
 * had already shipped.
 */
export class NonRetryableError extends Error {
  public readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export interface EnqueueJobInput {
  id?: string;
  kind: string;
  task_id?: string | null;
  payload?: Record<string, unknown>;
  run_after?: string | null;
  max_attempts?: number;
}

export function enqueueJob(db: DbConnection, input: EnqueueJobInput): BureauJobRow {
  const id = input.id ?? crypto.randomUUID();
  const payloadStr = JSON.stringify(input.payload ?? {});
  const now = new Date().toISOString();
  const maxAttempts = input.max_attempts ?? 3;

  return db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, run_after, attempts, max_attempts, reaped_count, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, 0, ?)`,
      id,
      input.kind,
      input.task_id ?? null,
      payloadStr,
      input.run_after ?? null,
      maxAttempts,
      now
    );

    journal(db, {
      kind: 'system',
      attribution: FOREMAN_ATTRIBUTION,
      taskId: input.task_id ?? null,
      jobId: id,
      detail: { action: 'enqueue', kind: input.kind }
    });

    const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', id);
    if (!job) {
      throw new Error(`Failed to create job ${id}`);
    }
    return job;
  });
}

export function enqueueJobIfAbsent(
  db: DbConnection,
  input: Required<Pick<EnqueueJobInput, 'id'>> & EnqueueJobInput
): { job: BureauJobRow; inserted: boolean } {
  const payloadStr = JSON.stringify(input.payload ?? {});
  const now = new Date().toISOString();
  const maxAttempts = input.max_attempts ?? 3;

  return db.execTransaction(() => {
    const res = db.run(
      `INSERT OR IGNORE INTO bureau_jobs (id, kind, task_id, payload, state, run_after, attempts, max_attempts, reaped_count, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, 0, ?)`,
      input.id,
      input.kind,
      input.task_id ?? null,
      payloadStr,
      input.run_after ?? null,
      maxAttempts,
      now
    );

    const inserted = res.changes > 0;
    if (inserted) {
      journal(db, {
        kind: 'system',
        attribution: FOREMAN_ATTRIBUTION,
        taskId: input.task_id ?? null,
        jobId: input.id,
        detail: { action: 'enqueue_if_absent', kind: input.kind }
      });
    }

    const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', input.id);
    if (!job) {
      throw new Error(`Failed to find job ${input.id}`);
    }
    return { job, inserted };
  });
}

export function claimJob(
  db: DbConnection,
  leaseOwner: string,
  leaseDurationMs: number,
  excludeKinds: readonly string[] = []
): BureauJobRow | null {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();

  // Some job kinds are owned by another executor and must never be claimed by
  // the general loop — chiefly `intake.turn`, which the console (and the demo
  // scripts) drain inline and immediately via claimJobById. Excluding them here
  // is what lets a background Runner coexist with the console's inline intake
  // without the two racing for the same job row.
  const kindFilter =
    excludeKinds.length > 0
      ? `AND kind NOT IN (${excludeKinds.map(() => '?').join(', ')})`
      : '';

  return db.execTransaction(() => {
    const claimed = db.all<BureauJobRow>(
      `UPDATE bureau_jobs
       SET state = 'running',
           lease_owner = ?,
           lease_expires_at = ?,
           started_at = COALESCE(started_at, ?)
       WHERE id = (
         SELECT id FROM bureau_jobs
         WHERE state = 'pending'
           AND (run_after IS NULL OR run_after <= ?)
           ${kindFilter}
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )
       RETURNING *`,
      leaseOwner,
      leaseExpiresAt,
      now,
      now,
      ...excludeKinds
    );

    if (!claimed || claimed.length === 0) {
      return null;
    }

    const job = claimed[0];
    journal(db, {
      kind: 'system',
      attribution: FOREMAN_ATTRIBUTION,
      taskId: job.task_id,
      jobId: job.id,
      detail: { action: 'claim', lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt }
    });

    return job;
  });
}

export function claimJobById(
  db: DbConnection,
  jobId: string,
  leaseOwner: string,
  leaseDurationMs: number
): BureauJobRow | null {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();

  return db.execTransaction(() => {
    const claimed = db.all<BureauJobRow>(
      `UPDATE bureau_jobs
       SET state = 'running',
           lease_owner = ?,
           lease_expires_at = ?,
           started_at = COALESCE(started_at, ?)
       WHERE id = ? AND state = 'pending'
       RETURNING *`,
      leaseOwner,
      leaseExpiresAt,
      now,
      jobId
    );

    if (!claimed || claimed.length === 0) {
      return null;
    }

    const job = claimed[0];
    journal(db, {
      kind: 'system',
      attribution: FOREMAN_ATTRIBUTION,
      taskId: job.task_id,
      jobId: job.id,
      detail: { action: 'claim', lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt }
    });

    return job;
  });
}

export function heartbeatJob(db: DbConnection, jobId: string, leaseOwner: string, leaseDurationMs: number): boolean {
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
  const res = db.run(
    `UPDATE bureau_jobs
     SET lease_expires_at = ?
     WHERE id = ? AND lease_owner = ? AND state = 'running'`,
    leaseExpiresAt,
    jobId,
    leaseOwner
  );
  return res.changes > 0;
}

export function completeJob(db: DbConnection, jobId: string, resultDetail?: Record<string, unknown>): void {
  const now = new Date().toISOString();

  db.execTransaction(() => {
    const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);
    if (!job) return;

    db.run(
      `UPDATE bureau_jobs
       SET state = 'done',
           finished_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = ?`,
      now,
      jobId
    );

    journal(db, {
      kind: 'system',
      attribution: FOREMAN_ATTRIBUTION,
      taskId: job.task_id,
      jobId,
      detail: { action: 'complete', ...(resultDetail ?? {}) }
    });
  });
}

export function failJob(
  db: DbConnection,
  jobId: string,
  error: string,
  backoffMs: number,
  opts?: { forceTerminal?: boolean }
): { terminal: boolean; job: BureauJobRow } {
  const now = new Date().toISOString();
  const truncatedError = error.slice(0, 2000);

  return db.execTransaction(() => {
    const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const newAttempts = job.attempts + 1;
    // A forced-terminal failure (NonRetryableError) is dead NOW — re-running
    // a deterministic refusal can never change the answer.
    const terminal = opts?.forceTerminal === true || newAttempts >= job.max_attempts;

    if (terminal) {
      db.run(
        `UPDATE bureau_jobs
         SET state = 'dead',
             attempts = ?,
             last_error = ?,
             finished_at = ?,
             run_after = NULL,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE id = ?`,
        newAttempts,
        truncatedError,
        now,
        jobId
      );
    } else {
      const runAfter = new Date(Date.now() + backoffMs).toISOString();
      db.run(
        `UPDATE bureau_jobs
         SET state = 'pending',
             attempts = ?,
             last_error = ?,
             run_after = ?,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE id = ?`,
        newAttempts,
        truncatedError,
        runAfter,
        jobId
      );
    }

    journal(db, {
      kind: 'system',
      attribution: FOREMAN_ATTRIBUTION,
      taskId: job.task_id,
      jobId,
      detail: { action: 'fail', terminal, attempts: newAttempts, error: truncatedError }
    });

    const updatedJob = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId)!;
    return { terminal, job: updatedJob };
  });
}

export function reapExpiredJobs(db: DbConnection): BureauJobRow[] {
  const now = new Date().toISOString();

  return db.execTransaction(() => {
    const expiredJobs = db.all<BureauJobRow>(
      `SELECT * FROM bureau_jobs WHERE state = 'running' AND lease_expires_at < ?`,
      now
    );

    const reaped: BureauJobRow[] = [];
    for (const job of expiredJobs) {
      db.run(
        `UPDATE bureau_jobs
         SET state = 'pending',
             lease_owner = NULL,
             lease_expires_at = NULL,
             reaped_count = reaped_count + 1
         WHERE id = ?`,
        job.id
      );

      journal(db, {
        kind: 'system',
        attribution: FOREMAN_ATTRIBUTION,
        taskId: job.task_id,
        jobId: job.id,
        detail: { action: 'lease-reaped', previous_owner: job.lease_owner }
      });

      const reapedJob = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', job.id);
      if (reapedJob) {
        reaped.push(reapedJob);
      }
    }

    return reaped;
  });
}
