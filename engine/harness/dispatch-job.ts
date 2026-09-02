import { getIdeDriver } from '../contract/ide-driver-seam.ts';
import type { AttributionTuple, BureauDispatchRow, JobContext, JobDefinition } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { acquireLease, releaseLease, startWindowLeaseHeartbeat } from './lease-manager.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { recordCorrelatedObservation } from '../selectors/correlation.ts';
import { callModel } from '../llm/call_model.ts';
import { JUNIOR_DISPATCH_SYSTEM_PROMPT, parseJuniorDispatchDecision } from '../review/junior_prompt.ts';
import { getAntigravityDriver, type AntigravityDriver, type AntigravityRunOptions, type AntigravityRunResult } from './antigravity-seam.ts';
import { findMainWindowWs, isJuniorWedgedWindowError, JUNIOR_PORT_WAIT_MS, recoverJuniorRunning, resolveJunior, type JuniorConfig } from './antigravity.ts';
import { readTaskAssignment } from '../flow/assignment.ts';
import { writeJuniorArtifacts } from './junior-artifacts.ts';
import { getWorkspaceProviderOverride } from '../contract/workspace-seam.ts';
import { notifyOperator } from '../state/notifications.ts';
import {
  changedAgainstBaseline,
  PrimaryTreeContaminatedError,
  resolvePrimaryRepoRoot,
  snapshotPrimaryTree,
  // `type` modifier: a plain named import of an interface breaks under
  // `node --experimental-strip-types` (the runtime never exports it) — caught
  // live by t38's demo child process, invisible to tsc and to vitest.
  type PrimaryTreeSnapshot
} from '../worktrees/primary_guard.ts';

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
 * flight: when the run fails with a wedged shape (port answered but no CDP
 * window/workbench ever appeared — dead job 8c6f373e; or F3: port dead while
 * the app's processes hold the single-instance lock, so a relaunch just
 * forwarded to the dead instance and the port never came up — the 2026-09-02
 * N9 scar), force a clean relaunch of that junior and retry the run ONCE
 * before letting the attempt fail. Without this, all of `junior.dispatch`'s
 * attempts burned against the same dead instance. Non-wedged failures (agent
 * errors, calibration misses, aborts) propagate untouched. The `recover` seam
 * exists so unit tests can verify the retry policy with a fake driver and a
 * fake relauncher.
 */
export async function runJuniorCommandWithWedgedRecovery(
  driver: AntigravityDriver,
  prompt: string,
  opts: AntigravityRunOptions,
  recover: (cfg: JuniorConfig) => Promise<unknown> = cfg =>
    // Wait for the relaunched workbench to be attachable (not just the port) before
    // the retry, so the re-attempt doesn't race the cold render and burn the attempt.
    // The port wait gets the FULL cold-start budget (JUNIOR_PORT_WAIT_MS, not the
    // 30s recoverJuniorRunning default): the F3 port-wedge class relaunches from
    // truly cold, and cold port-opens >30s under load are on the record. For the
    // window-wedge class the port is already live, so the longer budget is free.
    recoverJuniorRunning(cfg, { timeoutMs: JUNIOR_PORT_WAIT_MS, deps: { findWindow: findMainWindowWs } })
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

  // ---- N17: the junior identity of an agent (prompt) dispatch is RESOLVED
  // FROM THE TASK'S CLAIM-TIME PIN — never a silent default. Before this, a
  // dispatch whose payload lost its `junior` field fell back to `window-default`
  // and `resolveJunior(undefined)` = junior A with a FRESH conversation: the
  // 2026-09-02 incident where junior B's approved plan was handed to a
  // brand-new junior-A session. Now: payload pin must match the task's pin
  // (mismatch → guardrail, assignment wins); no pin at all → the dispatch
  // FAILS LOUD (a dispatch without a task row keeps the explicit payload pin,
  // e.g. CLI-driven standalone runs).
  let resolvedJunior: string | undefined;
  if (payload.prompt) {
    const assignment = dispatch.task_id ? readTaskAssignment(ctx.db, dispatch.task_id) : null;
    if (assignment) {
      if (payload.junior && payload.junior.toUpperCase() !== assignment.junior) {
        journal(ctx.db, {
          kind: 'guardrail',
          attribution: {
            actor_role: (dispatch.actor_role as any) || 'junior-engineer',
            provider: dispatch.provider || 'antigravity',
            model: dispatch.model || 'unspecified',
            account: dispatch.account ?? null
          },
          taskId: dispatch.task_id,
          workUuid: dispatch.work_uuid,
          jobId: ctx.job.id,
          detail: {
            action: 'assignment_pin_mismatch',
            door: 'junior.dispatch',
            payloadJunior: payload.junior,
            assignedJunior: assignment.junior,
            resolution: 'assignment wins'
          }
        });
      }
      resolvedJunior = assignment.junior;
    } else if (payload.junior) {
      resolvedJunior = payload.junior.toUpperCase();
    } else {
      journal(ctx.db, {
        kind: 'guardrail',
        attribution: {
          actor_role: (dispatch.actor_role as any) || 'junior-engineer',
          provider: dispatch.provider || 'antigravity',
          model: dispatch.model || 'unspecified',
          account: dispatch.account ?? null
        },
        taskId: dispatch.task_id,
        workUuid: dispatch.work_uuid,
        jobId: ctx.job.id,
        detail: {
          action: 'dispatch_unpinned_refused',
          reason: 'no claim-time assignment and no payload junior — refusing rather than defaulting to junior A / window-default'
        }
      });
      throw new Error(
        `Dispatch '${dispatch.id}' has no junior pin: the task has no claim-time assignment and the payload carries no 'junior'. ` +
          `Refusing to default to junior A / window-default (the 2026-09-02 cross-contamination class). ` +
          `Re-kick the task flow so the queue manager assigns it, or pin the junior explicitly.`
      );
    }
  }

  const windowTarget = payload.prompt
    ? `window-${resolvedJunior}`
    : payload.windowTarget || (payload.junior ? `window-${payload.junior}` : 'window-default');
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

  const internalAbortController = new AbortController();
  const combinedSignal = ctx.signal
    ? AbortSignal.any([ctx.signal, internalAbortController.signal])
    : internalAbortController.signal;

  const heartbeatHandle = startWindowLeaseHeartbeat(ctx.db, lease.id, {
    onError: (err) => {
      journal(ctx.db, {
        kind: 'guardrail',
        attribution,
        taskId: dispatch.task_id,
        workUuid: dispatch.work_uuid,
        jobId: ctx.job.id,
        detail: {
          reason: 'window_lease_heartbeat_failed',
          leaseId: lease.id,
          windowTarget,
          dispatchId: dispatch.id,
          error: err.message
        }
      });
      internalAbortController.abort(err);
    }
  });

  journal(ctx.db, {
    kind: 'system',
    attribution,
    taskId: dispatch.task_id,
    workUuid: dispatch.work_uuid,
    jobId: ctx.job.id,
    detail: {
      action: 'window_lease_heartbeat_started',
      leaseId: lease.id,
      windowTarget,
      dispatchId: dispatch.id,
      intervalMs: heartbeatHandle.intervalMs
    }
  });

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
      // N16: when the dispatch is worktree-scoped, remember the worktree path so
      // the post-dispatch guard can verify the PRIMARY checkout stayed clean.
      let deliveryWorktreePath: string | null = null;
      const wsProvider = getWorkspaceProviderOverride();
      if (payload.chainWorkReview && dispatch.task_id && wsProvider) {
        try {
          const handle = await wsProvider.prepare(ctx.db, dispatch.task_id);
          workFolder = handle.path;
          deliveryWorktreePath = handle.path;
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

      // F1: snapshot the primary tree's tracked-dirty set (with per-path content
      // oids) BEFORE driving the junior, so the post-dispatch N16 guard compares
      // against what was already dirty at dispatch start instead of demanding an
      // absolutely clean tree. Without this baseline, the operator's own
      // uncommitted ledger edit failed an innocent dispatch (N9, 2026-09-02). A
      // snapshot failure (no git at the derived root) falls back to the absolute
      // check below — same plumbing, so in practice both fail together and the
      // guard skips, exactly as before F1.
      let primaryBaseline: PrimaryTreeSnapshot | null = null;
      if (deliveryWorktreePath) {
        const primaryRoot = resolvePrimaryRepoRoot(deliveryWorktreePath);
        try {
          primaryBaseline = snapshotPrimaryTree(primaryRoot);
          journal(ctx.db, {
            kind: 'system',
            attribution,
            taskId: dispatch.task_id,
            workUuid: dispatch.work_uuid,
            jobId: ctx.job.id,
            detail: {
              action: 'primary_tree_baseline_captured',
              dispatchId: dispatch.id,
              primaryRoot,
              preexistingDirtyPaths: Object.keys(primaryBaseline.dirty)
            }
          });
        } catch (err: any) {
          journal(ctx.db, {
            kind: 'system',
            attribution,
            taskId: dispatch.task_id,
            workUuid: dispatch.work_uuid,
            jobId: ctx.job.id,
            detail: {
              action: 'primary_tree_baseline_failed',
              dispatchId: dispatch.id,
              primaryRoot,
              error: err?.message ?? String(err)
            }
          });
        }
      }

      const result = await runJuniorCommandWithWedgedRecovery(
        ag,
        payload.prompt,
        {
          // N17: the resolved pin (assignment wins over any payload pin).
          junior: resolvedJunior,
          port: payload.antigravityPort,
          model: payload.model,
          folder: workFolder,
          requireFolder,
          freshConversation: payload.freshConversation,
          signal: combinedSignal
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
          junior: result.junior ?? resolvedJunior ?? payload.junior ?? null,
          dispatchId: dispatch.id,
          prompt: payload.prompt,
          // F2: auditability of the conversation mode this dispatch ran in —
          // 'continue' (meant to continue the task's conversation; the prompt is
          // self-contained regardless) or 'fresh'.
          conversationMode: payload.freshConversation === false ? 'continue' : 'fresh',
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

      // N16 — the primary-checkout contamination guard. The dispatch was scoped
      // to the worktree (a dedicated folder window for junior A, or the worktree
      // path injected into the prompt for the single-window junior B), but an
      // agent that also holds the primary folder open (or edits by absolute
      // path) can leak uncommitted edits into main's TRACKED files — the
      // 0e921cfa scar: ~284 lines of unreviewed engine code in the primary
      // tree, rescued only by a hand stash. After every worktree-scoped
      // dispatch, re-snapshot and flag only what the run ITSELF dirtied (F1
      // baseline diff: newly-dirty paths and content changes; the operator's
      // pre-existing uncommitted edits are NOT the junior's doing). No baseline
      // (snapshot failed) degrades to the pre-F1 absolute check — conservative,
      // fail-loud. On contamination fail LOUD (guardrail span + operator
      // notification + a failed dispatch), never silently let junior edits ride
      // into a fresh process's module graph.
      if (deliveryWorktreePath) {
        const primaryRoot = resolvePrimaryRepoRoot(deliveryWorktreePath);
        try {
          const after = snapshotPrimaryTree(primaryRoot);
          const dirtyPaths = primaryBaseline
            ? changedAgainstBaseline(primaryBaseline, after)
            : Object.keys(after.dirty).sort();
          if (dirtyPaths.length > 0) {
            journal(ctx.db, {
              kind: 'guardrail',
              attribution,
              taskId: dispatch.task_id,
              workUuid: dispatch.work_uuid,
              jobId: ctx.job.id,
              detail: {
                action: 'primary_checkout_contaminated',
                dispatchId: dispatch.id,
                primaryRoot,
                dirtyPaths,
                preexistingDirtyPaths: primaryBaseline ? Object.keys(primaryBaseline.dirty) : null
              }
            });
            notifyOperator(
              ctx.job.id,
              `Dispatch ${dispatch.id} contaminated the PRIMARY checkout: ${dirtyPaths.length} tracked path(s) ` +
                `modified (${dirtyPaths.slice(0, 5).join(', ')}${dirtyPaths.length > 5 ? ', …' : ''}). ` +
                `Dispatch failed loud — inspect and stash/discard the changes before re-driving.`
            );
            throw new PrimaryTreeContaminatedError(dirtyPaths);
          }
          journal(ctx.db, {
            kind: 'system',
            attribution,
            taskId: dispatch.task_id,
            workUuid: dispatch.work_uuid,
            jobId: ctx.job.id,
            detail: {
              action: 'primary_tree_verified_clean',
              dispatchId: dispatch.id,
              primaryRoot,
              againstBaseline: !!primaryBaseline
            }
          });
        } catch (err: any) {
          if (err instanceof PrimaryTreeContaminatedError) throw err;
          // The inspection itself failed (not the tree) — journaled skip, not a
          // hard failure: the guard must not kill dispatches over its own
          // plumbing (e.g. an exotic provider layout with no git at the
          // derived root).
          journal(ctx.db, {
            kind: 'system',
            attribution,
            taskId: dispatch.task_id,
            workUuid: dispatch.work_uuid,
            jobId: ctx.job.id,
            detail: { action: 'primary_tree_guard_skipped', error: err?.message ?? String(err), dispatchId: dispatch.id }
          });
        }
      }
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
        if (combinedSignal.aborted) {
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
              signal: combinedSignal
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
            // Carry who to drive on a REVISE: the SAME junior that implemented
            // (N17 pin), and the SAME senior across fix rounds (when known).
            ...(resolvedJunior ? { junior: resolvedJunior } : {}),
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
    const totalHeartbeats = heartbeatHandle.stop();
    journal(ctx.db, {
      kind: 'system',
      attribution,
      taskId: dispatch.task_id,
      workUuid: dispatch.work_uuid,
      jobId: ctx.job.id,
      detail: {
        action: 'window_lease_heartbeat_stopped',
        leaseId: lease.id,
        windowTarget,
        dispatchId: dispatch.id,
        heartbeats: totalHeartbeats
      }
    });
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
