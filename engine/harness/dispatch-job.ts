import { getIdeDriver } from '../contract/ide-driver-seam.ts';
import type { AttributionTuple, BureauDispatchRow, JobContext, JobDefinition } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { acquireLease, releaseLease } from './lease-manager.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { recordCorrelatedObservation } from '../selectors/correlation.ts';
import { callModel } from '../llm/call_model.ts';
import { JUNIOR_DISPATCH_SYSTEM_PROMPT, parseJuniorDispatchDecision } from '../review/junior_prompt.ts';
import { getAntigravityDriver, type AntigravityDriver, type AntigravityRunOptions, type AntigravityRunResult } from './antigravity-seam.ts';
import { isJuniorWedgedWindowError, recoverJuniorRunning, resolveJunior, type JuniorConfig } from './antigravity.ts';
import { writeJuniorArtifacts } from './junior-artifacts.ts';
import { getWorkspaceProviderOverride } from '../contract/workspace-seam.ts';

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
  /** When true, on successful completion enqueue a `work.cycle` so a senior reads
   *  the junior's walkthrough. Set by the plan cycle's implementation dispatch so
   *  the flow reaches a work review instead of dead-ending after the code lands. */
  chainWorkReview?: boolean;
  /** Carried across work-review fix rounds so the SAME senior re-reviews and the
   *  chained work.cycle knows which senior/model to use. */
  workSeniorId?: string;
  workSeniorModel?: string;
}

/**
 * Drive the junior for one dispatch attempt, self-healing a WEDGED GUI in
 * flight: when the run fails with the wedged-window shape (port answered, but
 * no CDP window/workbench ever appeared — dead job 8c6f373e), force a clean
 * relaunch of that junior and retry the run ONCE before letting the attempt
 * fail. Without this, all of `junior.dispatch`'s attempts burned against the
 * same dead instance. Non-wedged failures (agent errors, calibration misses,
 * aborts) propagate untouched. The `recover` seam exists so unit tests can
 * verify the retry policy with a fake driver and a fake relauncher.
 */
export async function runJuniorCommandWithWedgedRecovery(
  driver: AntigravityDriver,
  prompt: string,
  opts: AntigravityRunOptions,
  recover: (cfg: JuniorConfig) => Promise<unknown> = cfg => recoverJuniorRunning(cfg)
): Promise<AntigravityRunResult> {
  try {
    return await driver.runCommand(prompt, opts);
  } catch (err) {
    if (!isJuniorWedgedWindowError(err)) throw err;
    await recover(resolveJunior(opts.junior));
    return await driver.runCommand(prompt, opts);
  }
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

      // Point the junior at the task's BUREAU WORKTREE so its edits/commits land
      // on the delivery branch (`bureau-wt-<taskId>`) that pr.create pushes and
      // pr.merge merges — instead of an unrelated workspace the department can't
      // deliver from. Only for delivery-bound dispatches (implementation/fix runs
      // chain a work review) and only when a workspace provider is registered (the
      // live runner); plan-only work and provider-less tests keep the caller's
      // folder. Idempotent with the approve-path worktree.prepare (prepare adopts
      // an existing worktree). A prepare failure falls back to the caller's folder
      // rather than failing the dispatch — surfaced in the journal.
      let workFolder = payload.folder;
      let requireFolder = false;
      const wsProvider = getWorkspaceProviderOverride();
      if (payload.chainWorkReview && dispatch.task_id && wsProvider) {
        try {
          const handle = await wsProvider.prepare(ctx.db, dispatch.task_id);
          workFolder = handle.path;
          // The junior MUST land in the worktree for its commits to be delivered;
          // a silent miss (selectFolder can't open a fresh path) would place work
          // in the wrong workspace. Make it a hard failure downstream.
          requireFolder = true;
          journal(ctx.db, {
            kind: 'system',
            attribution,
            taskId: dispatch.task_id,
            workUuid: dispatch.work_uuid,
            jobId: ctx.job.id,
            detail: { action: 'junior_pointed_at_worktree', path: handle.path, dispatchId: dispatch.id }
          });
        } catch (err: any) {
          journal(ctx.db, {
            kind: 'system',
            attribution,
            taskId: dispatch.task_id,
            workUuid: dispatch.work_uuid,
            jobId: ctx.job.id,
            detail: { action: 'junior_worktree_prepare_failed', error: err?.message ?? String(err), dispatchId: dispatch.id }
          });
        }
      }

      const result = await runJuniorCommandWithWedgedRecovery(
        ag,
        payload.prompt,
        {
          junior: payload.junior,
          port: payload.antigravityPort,
          model: payload.model,
          folder: workFolder,
          requireFolder,
          freshConversation: payload.freshConversation,
          signal: ctx.signal
        }
      );

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
      // Close the loop: a plan-originated implementation dispatch chains into a
      // work review so a senior reads the walkthrough. Enqueued in the SAME
      // transaction as completion so it is durable (nothing fire-and-forget).
      if (payload.chainWorkReview && dispatch.task_id) {
        enqueueJob(ctx.db, {
          kind: 'work.cycle',
          task_id: dispatch.task_id,
          payload: {
            taskId: dispatch.task_id,
            // Carry who to drive on a REVISE: the SAME junior that implemented,
            // and the SAME senior across fix rounds (when known).
            ...(payload.junior ? { junior: payload.junior } : {}),
            ...(payload.model ? { juniorModel: payload.model } : {}),
            ...(payload.folder ? { folder: payload.folder } : {}),
            ...(payload.workSeniorId ? { seniorId: payload.workSeniorId } : {}),
            ...(payload.workSeniorModel ? { seniorModel: payload.workSeniorModel } : {})
          },
          max_attempts: 1
        });
      }
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
    // The live path is registered in engine/jobs/registry.ts; keep this in sync.
    // A junior implementation dispatch drives a GUI agent for many minutes.
    timeoutMs: 30 * 60 * 1000
  }
};
