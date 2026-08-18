import { z } from 'zod';
import {
  DETERMINISTIC_ATTRIBUTION,
  type AttributionTuple,
  type BureauJobRow,
  type BureauSelectorRow,
  type DbConnection,
  type JobContext
} from '../contract/index.ts';
import { getIdeDriver } from '../contract/ide-driver-seam.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { GatedIdeDriver } from './gate.ts';

export interface RegisterSelectorInput {
  key: string;
  css: string;
  attribution?: Partial<AttributionTuple>;
}

export function registerSelector(db: DbConnection, input: RegisterSelectorInput): BureauSelectorRow {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actorRole = input.attribution?.actor_role ?? 'system';
  const provider = input.attribution?.provider ?? DETERMINISTIC_ATTRIBUTION.provider;
  const model = input.attribution?.model ?? DETERMINISTIC_ATTRIBUTION.model;
  const account = input.attribution?.account ?? null;

  return db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_selectors (id, key, css, status, match_count, attempts, actor_role, provider, model, account, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', 0, 0, ?, ?, ?, ?, ?, ?)`,
      id,
      input.key,
      input.css,
      actorRole,
      provider,
      model,
      account,
      now,
      now
    );

    const selector = getSelector(db, input.key);
    if (!selector) {
      throw new Error(`Failed to create selector for key ${input.key}`);
    }
    return selector;
  });
}

export function getSelector(db: DbConnection, key: string): BureauSelectorRow | null {
  const row = db.get<BureauSelectorRow>('SELECT * FROM bureau_selectors WHERE key = ?', key);
  return row ?? null;
}

export function enqueueSelectorCalibration(
  db: DbConnection,
  key: string,
  options?: { maxReads?: number; taskId?: string | null }
): BureauJobRow {
  return enqueueJob(db, {
    kind: 'selector.calibrate',
    task_id: options?.taskId ?? null,
    payload: {
      key,
      maxReads: options?.maxReads ?? 3
    }
  });
}

export const selectorCalibrateSchema = z.object({
  key: z.string(),
  maxReads: z.number().optional().default(3)
});

export async function selectorCalibrateHandler(ctx: JobContext): Promise<void> {
  const payload = selectorCalibrateSchema.parse(ctx.payload ?? {});
  const { key, maxReads } = payload;

  const selector = getSelector(ctx.db, key);
  if (!selector) {
    throw new Error(`Selector key "${key}" not found in bureau_selectors.`);
  }

  // Calibration is the bureau's measurement act entitled to raw reads;
  // unwrap GatedIdeDriver to prevent deadlock when calibrating from draft status.
  const d = getIdeDriver();
  const driver = d instanceof GatedIdeDriver ? d.innerDriver : d;
  let consistentOneMatch = true;
  let lastObservedMatchCount = 0;

  for (let i = 0; i < maxReads; i++) {
    if (ctx.signal.aborted) {
      throw new Error(`Calibration job for selector "${key}" aborted.`);
    }

    const readRes = await driver.read(key);
    lastObservedMatchCount = readRes.matchCount;

    if (readRes.matchCount !== 1) {
      consistentOneMatch = false;
      break;
    }
  }

  const now = new Date().toISOString();
  const newStatus = consistentOneMatch ? 'calibrated' : 'failed';
  const newAttempts = selector.attempts + 1;

  ctx.db.execTransaction(() => {
    dbUpdateSelector(ctx.db, key, newStatus, lastObservedMatchCount, newAttempts, now);

    journal(ctx.db, {
      kind: consistentOneMatch ? 'system' : 'guardrail',
      attribution: {
        actor_role: 'system',
        ...DETERMINISTIC_ATTRIBUTION
      },
      taskId: ctx.job.task_id,
      jobId: ctx.job.id,
      detail: {
        action: 'selector.calibrate',
        key,
        status: newStatus,
        matchCount: lastObservedMatchCount,
        attempts: newAttempts,
        maxReads
      }
    });
  });

  if (!consistentOneMatch) {
    throw new Error(
      `Selector "${key}" failed calibration: observed match count ${lastObservedMatchCount} (expected exactly 1).`
    );
  }
}

function dbUpdateSelector(
  db: DbConnection,
  key: string,
  status: 'calibrated' | 'failed',
  matchCount: number,
  attempts: number,
  now: string
): void {
  db.run(
    `UPDATE bureau_selectors
     SET status = ?,
         match_count = ?,
         attempts = ?,
         last_calibrated_at = COALESCE(?, last_calibrated_at),
         updated_at = ?
     WHERE key = ?`,
    status,
    matchCount,
    attempts,
    status === 'calibrated' ? now : null,
    now,
    key
  );
}
