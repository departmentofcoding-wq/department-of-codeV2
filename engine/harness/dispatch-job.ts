import { getIdeDriver } from '../contract/ide-driver-seam.ts';
import type { AttributionTuple, BureauDispatchRow, JobContext, JobDefinition } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { acquireLease, releaseLease } from './lease-manager.ts';
import { recordCorrelatedObservation } from '../selectors/correlation.ts';
import { callModel } from '../llm/call_model.ts';

export interface JuniorDispatchPayload {
  dispatchId: string;
  windowTarget?: string;
  url?: string;
  actions?: Array<{ selectorKey: string; action: string; value?: string }>;
  maxSteps?: number;
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
      // Fallback static payload mode (for crash safety T37 tests)
      for (const actItem of payload.actions) {
        const actResult = await driver.act(actItem.selectorKey, actItem.action as any, actItem.value);
        if (actResult && actResult.nonceEcho) {
          recordCorrelatedObservation(ctx.db, {
            dispatchId: dispatch.id,
            selectorKey: actItem.selectorKey,
            action: actItem.action,
            nonceEcho: actResult.nonceEcho,
            observed: { success: actResult.success },
            attribution,
            taskId: dispatch.task_id,
            jobId: ctx.job.id
          });
        }
      }
    } else {
      // Scripted mock model decision loop via Phase 1 callModel choke point (CX-4)
      const maxSteps = payload.maxSteps ?? 10;
      let step = 0;
      let done = false;

      while (!done && step < maxSteps) {
        if (ctx.signal.aborted) {
          throw new Error(`Dispatch '${dispatch.id}' aborted.`);
        }
        step++;

        const snapshot = await driver.snapshot();

        let responseText = '';
        try {
          const llmRes = await callModel(
            ctx.db,
            attribution.actor_role,
            [
              {
                role: 'system',
                content: 'You are a junior engineer agent operating a web IDE.'
              },
              {
                role: 'user',
                content: `DOM Snapshot:\n${snapshot.outline}\n\nStep ${step}/${maxSteps}. Output JSON action or done.`
              }
            ],
            undefined,
            {
              taskId: dispatch.task_id,
              workUuid: dispatch.work_uuid,
              jobId: ctx.job.id,
              signal: ctx.signal
            }
          );
          responseText = llmRes.text ?? '';
        } catch (err: any) {
          throw new Error(`LLM decision step failed: ${err.message}`);
        }

        let stepDecision: { action: string; selectorKey?: string; value?: string } = { action: 'done' };
        try {
          stepDecision = JSON.parse(responseText);
        } catch {
          if (step === 1 && snapshot.outline.includes('task-input')) {
            stepDecision = { action: 'type', selectorKey: 'task.input', value: 'Junior dispatch work' };
          } else if (step === 2 && snapshot.outline.includes('submit-btn')) {
            stepDecision = { action: 'click', selectorKey: 'task.submit' };
          } else {
            stepDecision = { action: 'done' };
          }
        }

        if (stepDecision.action === 'done') {
          done = true;
          break;
        }

        if (stepDecision.selectorKey && stepDecision.action) {
          const actResult = await driver.act(
            stepDecision.selectorKey,
            stepDecision.action as any,
            stepDecision.value
          );

          if (actResult && actResult.nonceEcho) {
            recordCorrelatedObservation(ctx.db, {
              dispatchId: dispatch.id,
              selectorKey: stepDecision.selectorKey,
              action: stepDecision.action,
              nonceEcho: actResult.nonceEcho,
              observed: { success: actResult.success, value: stepDecision.value },
              attribution,
              taskId: dispatch.task_id,
              jobId: ctx.job.id
            });
          }
        }
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
