import { getIdeDriver } from '../contract/ide-driver-seam.ts';
import type { AttributionTuple, BureauDispatchRow, JobContext, JobDefinition } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { acquireLease, releaseLease } from './lease-manager.ts';
import { recordCorrelatedObservation } from '../selectors/correlation.ts';
import { callModel } from '../llm/call_model.ts';
import { JUNIOR_DISPATCH_SYSTEM_PROMPT, parseJuniorDispatchDecision } from '../review/junior_prompt.ts';
import { getAntigravityDriver } from './antigravity-seam.ts';
import { writeJuniorArtifacts } from './junior-artifacts.ts';

export interface JuniorDispatchPayload {
  dispatchId: string;
  windowTarget?: string;
  url?: string;
  actions?: Array<{ selectorKey: string; action: string; value?: string }>;
  maxSteps?: number;
  /** Natural-language command for the Antigravity junior agent. When set, the
   *  dispatch drives Antigravity via CDP instead of the selector/LLM loop. */
  prompt?: string;
  antigravityPort?: number;
  /** Which junior to drive: 'A' = Antigravity IDE, 'B' = Antigravity 2.0. Default A. */
  junior?: string;
  /** Model to select in the junior's GUI picker before sending the prompt. */
  model?: string;
  /** Folder/project to select in the junior's GUI before sending the prompt. */
  folder?: string;
  /** Start a fresh conversation first (default true). Planning-originated
   *  implementation dispatches set this false so the junior CONTINUES in the same
   *  conversation it planned in — it already holds the approved plan + review
   *  context, and the IDE may expose no reset control to open a fresh one. */
  freshConversation?: boolean;
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
    if (payload.prompt) {
      // Antigravity junior path: send a natural-language command to the live
      // agent via CDP and record its transcript as an attributed observation.
      const ag = getAntigravityDriver();
      const result = await ag.runCommand(payload.prompt, {
        junior: payload.junior,
        port: payload.antigravityPort,
        model: payload.model,
        folder: payload.folder,
        freshConversation: payload.freshConversation,
        signal: ctx.signal
      });

      // Persist plan/walkthrough/full-output as reviewable department data.
      // Guarded to the rich (real-driver) path so fake-driver tests, which
      // return only `transcript`, never write to the filesystem.
      let artifactFiles: Record<string, string> = {};
      if (result.fullOutput || result.plan || result.walkthrough) {
        const written = writeJuniorArtifacts(dispatch.task_id, dispatch.id, {
          junior: result.junior,
          fullOutput: result.fullOutput,
          plan: result.plan,
          walkthrough: result.walkthrough,
          reply: result.transcript
        });
        artifactFiles = written.files;
      }

      journal(ctx.db, {
        kind: 'observation',
        attribution,
        taskId: dispatch.task_id,
        workUuid: dispatch.work_uuid,
        jobId: ctx.job.id,
        detail: {
          source: 'antigravity',
          junior: result.junior ?? payload.junior ?? 'A',
          dispatchId: dispatch.id,
          prompt: payload.prompt,
          model: result.model ?? payload.model ?? null,
          folder: payload.folder ?? null,
          folderSelected: result.folderSelected ?? null,
          launched: result.launched,
          transcriptTail: result.transcript,
          hasPlan: !!(result.plan && result.plan.trim()),
          hasWalkthrough: !!(result.walkthrough && result.walkthrough.trim()),
          artifactFiles
        }
      });
    } else if (payload.actions && Array.isArray(payload.actions)) {
      // Retrieve IDE driver from neutral seam (X3: never touch override inside job handler)
      const driver = getIdeDriver();
      if (payload.url) {
        await driver.navigate(payload.url);
      }
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
      const driver = getIdeDriver();
      if (payload.url) {
        await driver.navigate(payload.url);
      }
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
                content: JUNIOR_DISPATCH_SYSTEM_PROMPT
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

        let stepDecision: { action: string; selectorKey?: string; value?: string };
        try {
          stepDecision = parseJuniorDispatchDecision(responseText);
        } catch (err: any) {
          throw new Error(`LLM decision step returned unparseable output '${responseText}': ${err.message}`);
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
