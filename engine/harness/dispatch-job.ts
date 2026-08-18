import { getIdeDriver } from '../contract/ide-driver-seam.ts';
import type { AttributionTuple, BureauDispatchRow, JobContext, JobDefinition } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { acquireLease, releaseLease } from './lease-manager.ts';

export interface JuniorDispatchPayload {
  dispatchId: string;
  windowTarget?: string;
  url?: string;
  actions?: Array<{ selectorKey: string; action: string; value?: string }>;
}

export async function handleJuniorDispatch(ctx: JobContext): Promise<void> {
  const payload = ctx.payload as JuniorDispatchPayload;
  if (!payload || !payload.dispatchId) {
    throw new Error("Junior dispatch job missing required payload 'dispatchId'");
  }

  const dispatch = ctx.db.get<BureauDispatchRow>(
    'SELECT * FROM bureau_dispatches WHERE id = ?',
    payload.dispatchId
  );

  if (!dispatch) {
    throw new Error(`Dispatch '${payload.dispatchId}' not found in bureau_dispatches`);
  }

  const windowTarget = payload.windowTarget || 'window-default';
  const nowIso = new Date().toISOString();

  // Transactionally update dispatch status to running and increment attempts
  ctx.db.execTransaction(() => {
    ctx.db.run(
      `UPDATE bureau_dispatches SET status = 'running', attempts = attempts + 1 WHERE id = ?`,
      dispatch.id
    );
  });

  const attribution: AttributionTuple = {
    actor_role: (dispatch.actor_role as any) || 'junior-engineer',
    provider: dispatch.provider || 'ollama',
    model: dispatch.model || 'qwen2.5-coder',
    account: dispatch.account ?? null
  };

  // Journal dispatch running span
  journal(ctx.db, {
    kind: 'dispatch',
    attribution,
    taskId: dispatch.task_id,
    workUuid: dispatch.work_uuid,
    jobId: ctx.job.id,
    detail: {
      status: 'running',
      dispatchId: dispatch.id,
      windowTarget
    }
  });

  // Acquire window lease
  const lease = acquireLease(ctx.db, windowTarget, dispatch.id, attribution);

  try {
    // Retrieve IDE driver from neutral seam (X3: never touch override inside job handler)
    const driver = getIdeDriver();

    if (payload.url) {
      await driver.navigate(payload.url);
    }

    if (payload.actions && Array.isArray(payload.actions)) {
      for (const actItem of payload.actions) {
        await driver.act(actItem.selectorKey, actItem.action as any, actItem.value);
      }
    }

    const finishIso = new Date().toISOString();
    ctx.db.execTransaction(() => {
      ctx.db.run(
        `UPDATE bureau_dispatches SET status = 'completed', finished_at = ? WHERE id = ?`,
        finishIso,
        dispatch.id
      );
    });

    journal(ctx.db, {
      kind: 'dispatch',
      attribution,
      taskId: dispatch.task_id,
      workUuid: dispatch.work_uuid,
      jobId: ctx.job.id,
      detail: {
        status: 'completed',
        dispatchId: dispatch.id,
        finished_at: finishIso
      }
    });
  } catch (err: any) {
    const failIso = new Date().toISOString();
    journal(ctx.db, {
      kind: 'dispatch',
      attribution,
      taskId: dispatch.task_id,
      workUuid: dispatch.work_uuid,
      jobId: ctx.job.id,
      detail: {
        status: 'failed',
        dispatchId: dispatch.id,
        error: err.message
      }
    });
    throw err;
  } finally {
    // Always release lease on exit (clean or error)
    releaseLease(ctx.db, lease.id);
  }
}

export const juniorDispatchJobDefinition: JobDefinition = {
  kind: 'junior.dispatch',
  schema: {},
  handler: handleJuniorDispatch,
  options: {
    maxAttempts: 3,
    timeoutMs: 120000
  }
};
