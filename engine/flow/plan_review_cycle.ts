import crypto from 'node:crypto';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { DEFAULT_PLAN_ROUNDS_CEILING, DEFAULT_SENIOR_STALL_RETRIES, REVIEW_PR_META_KEYS } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { transition } from '../state/machine.ts';
import { notifyOperator } from '../state/notifications.ts';
import { getAntigravityDriver, type AntigravityRunResult } from '../harness/antigravity-seam.ts';
import { assignJunior, JUNIOR_COMPLETION_INSTRUCTION, sliceAfterPrompt } from '../harness/antigravity.ts';
import { releaseLease, startWindowLeaseHeartbeat, waitForWindowLease } from '../harness/lease-manager.ts';
import { getSeniorDriver } from '../harness/senior-seam.ts';
import { assignSeniorForTask } from '../harness/senior.ts';
import { evaluatePlanRubric, SENIOR_RUBRIC_ATTRIBUTION } from '../review/plan_review_job.ts';
import { DEFAULT_AUTHORING_LEASE_WAIT_MS } from '../contract/constants.ts';

/**
 * Plan-review cycle — the department flow for the planning stage, integrating
 * the live harnesses (Antigravity junior, Claude/ZCode senior) with the jobs
 * machinery's guards:
 *
 *   TASK  →  junior AUTHORS the plan  →  deterministic RUBRIC gate  →
 *   senior REVIEWS the plan (with the task verbatim)  →  approve | revise.
 *
 *   - approve  → a `bureau_dispatches` row is created and `junior.dispatch` is
 *     enqueued with the approved plan as the implementation prompt (the
 *     legacy job's continuation, now on the harness path).
 *   - revise   → the senior's feedback is fed back to the junior and the next
 *     `plan.cycle` round is enqueued — the cycle actually cycles, bounded by
 *     the `plan_rounds` ceiling.
 *
 * Guards inherited from the legacy `senior.review-plan` job (both were missing
 * on the harness path this module replaced):
 *   - state gate: only `queued`/`claimed` tasks may plan;
 *   - ceiling entry-guard: at `plan_rounds >= ceiling` the cycle REFUSES
 *     (guardrail span, task blocked, operator notified) — never silently
 *     continues;
 *   - deterministic rubric before any senior tokens are spent.
 *
 * Every step writes real DB rows (`bureau_plans`, `bureau_plan_reviews`,
 * `bureau_jobs`) and attributed journal spans. `runPlanReviewCycle` is the
 * engine; the `plan.cycle` job kind and `scripts/run_plan_cycle.ts` are doors
 * to it — nothing fire-and-forget.
 */

/** Attribution recorded when no real model label is known — honest, never a
 *  fabricated model name. */
const UNSPECIFIED_MODEL = 'unspecified';

export interface PlanCycleOptions {
  taskId: string;
  /** Which junior authors the plan: 'A' = IDE, 'B' = 2.0. Default A. */
  junior?: string;
  /** Which senior reviews. Default: the assignment policy (one reviewer). */
  seniorId?: string;
  /** Optional GUI model selections. */
  juniorModel?: string;
  seniorModel?: string;
  /** Optional workspace/folder for the junior. */
  folder?: string;
  /** Inactivity (stall) window for the junior, ms — NOT a cap on work time. */
  juniorStallMs?: number;
  /** N11: how long authoring may WAIT for the per-junior window lease when
   *  another same-junior cycle holds it (serialization, not collision).
   *  Default DEFAULT_AUTHORING_LEASE_WAIT_MS (10 min). */
  juniorLeaseWaitMs?: number;
  /** Cancellation (job timeout / runner shutdown), honored by the waits. */
  signal?: AbortSignal;
  /** The job invoking this cycle, for span attribution. */
  jobId?: string;
  /** Prior round's review feedback, fed back to the junior (round N+1). */
  priorFeedback?: string;
}

export type PlanCycleResult =
  | {
      outcome: 'refused';
      reason: 'ceiling' | 'state';
      roundsUsed: number;
      ceiling: number;
    }
  | {
      outcome: 'approved';
      planId: string;
      planText: string;
      junior: string;
      senior: string;
      feedback: string;
      roundsUsed: number;
      ceiling: number;
      dispatchJobId: string;
    }
  | {
      outcome: 'revise';
      planId: string;
      planText: string;
      junior: string;
      /** Who returned the revise: the senior, or the deterministic rubric. */
      by: 'senior' | 'rubric';
      senior?: string;
      feedback: string;
      roundsUsed: number;
      ceiling: number;
      /** Next round enqueued (false when the ceiling was hit). */
      nextRoundEnqueued: boolean;
      /** Set when the ceiling was reached and, instead of blocking, the junior was
       *  sent to implement on the best-available plan (walkthrough review gates). */
      ceilingDispatchJobId?: string;
    }
  | { outcome: 'blocked'; reason: 'senior_stall_exhausted'; senior: string; attempts: number };

/** Options carried across rounds of the cycle. */
interface CycleCarry {
  junior?: string;
  seniorId?: string;
  juniorModel?: string;
  seniorModel?: string;
  folder?: string;
  juniorStallMs?: number;
}

/**
 * Hand the junior the task and let it plan in its own way — plan only, no code
 * yet. The prompt states the department's plan standard up front (branch,
 * enumerable scope, tests + mutation evidence, walkthrough plan) so the
 * deterministic rubric and the senior judge against a standard the junior was
 * actually told about. A prior round's senior feedback is included verbatim.
 */
export function buildJuniorPlanPrompt(
  task: BureauTaskRow,
  priorFeedback?: string,
  projectInfo?: { name: string; path: string }
): string {
  return (
    'Here is a task for you to plan. Do NOT write any code yet — a senior will ' +
    'review your implementation plan first.\n\n' +
    `Your plan MUST include: (1) work directly on the branch already checked out in the worktree (bureau-wt-${task.id}); do not create, switch, or rename branches, (2) an ` +
    'enumerable scope (components and files to change), (3) the tests you will ' +
    'add and the mutation evidence you will record, and (4) a walkthrough / ' +
    'verification plan.\n\n' +
    'Format requirement: Emit your plan in a marked, structured format using a top-level # Implementation Plan (or ## Plan) header with sections corresponding to the requirements above. Conversational responses without a structured plan will be rejected.\n\n' +
    (priorFeedback
      ? `The senior reviewed your PREVIOUS plan and required these changes — address every point:\n` +
        `${priorFeedback}\n\n`
      : '') +
    '===== TASK =====\n' +
    `TITLE: ${task.title}\n` +
    (projectInfo ? `PROJECT: ${projectInfo.name} (${projectInfo.path})\n` : '') +
    (task.intent ? `INTENT: ${task.intent}\n` : '') +
    (task.spec ? `SPEC: ${task.spec}\n` : '') +
    (task.acceptance ? `ACCEPTANCE: ${task.acceptance}\n` : '')
    // N13: plan AUTHORING deliberately does NOT carry the completion sentinel, so
    // the driver's N0 evidence gate stays DISARMED for authoring. The N0 race
    // (an agent that goes idle while its own long terminal subprocess runs) is an
    // IMPLEMENTATION concern; during authoring the agent explores briefly then
    // writes a plan, and its live "Working…" indicator reliably marks activity, so
    // idle+stable is the correct, proven (pre-N0) completion signal. Requiring the
    // sentinel here caused intermittent stalls: when the agent finished authoring
    // but did not echo the exact marker line, the 5-minute evidence timeout reaped
    // it and DISCARDED the authored plan (the N9/N10/N11 "no progress for the stall
    // window" deaths). The sentinel stays on the IMPLEMENTATION and fix prompts,
    // where the subprocess race is real.
  );
}

/** How the junior arrived at implementation: an approved plan, or the review-round
 *  ceiling reached with feedback still outstanding. The prompt must tell the
 *  junior the truth — never claim "approved" on the ceiling path. */
export interface ImplementationBasis {
  /** True only when a senior actually returned APPROVE on this plan. */
  approved: boolean;
  /** The final review feedback (senior or rubric), threaded to the junior so it
   *  implements against the last-known required changes — especially on the
   *  ceiling path, where that feedback was never addressed in a further round. */
  feedback?: string;
  /** How many plan rounds were spent (for the honest ceiling wording). */
  roundsUsed?: number;
  ceiling?: number;
}

/**
 * The implementation prompt handed to the junior via `junior.dispatch`. The
 * task verbatim plus the plan, with the department's working rules (branch,
 * tests, walkthrough when done). The header is HONEST about how we got here:
 *  - approved  → "reviewed and APPROVED; implement exactly as planned";
 *  - ceiling   → "review-round ceiling reached with feedback still outstanding;
 *    implement on this plan and ADDRESS the final required changes below."
 */
export function buildImplementationPrompt(
  task: BureauTaskRow,
  planText: string,
  basis: ImplementationBasis = { approved: true },
  projectInfo?: { name: string; path: string }
): string {
  const header = basis.approved
    ? 'Your implementation plan was reviewed and APPROVED by a senior. Implement ' +
      'it now, exactly as planned.\n\n'
    : `Your plan went through ${basis.roundsUsed ?? 'the maximum'} review round(s) and the ` +
      `review-round ceiling${basis.ceiling ? ` (${basis.ceiling})` : ''} was reached with the ` +
      "senior's feedback still outstanding. Rather than stall the task, implement now on this " +
      'plan — but you MUST address the final required changes below as you do.\n\n';
  const feedbackBlock =
    basis.feedback && basis.feedback.trim()
      ? `\n===== SENIOR'S FINAL REQUIRED CHANGES =====\n${basis.feedback.trim()}\n`
      : '';
  const planLabel = basis.approved ? 'APPROVED PLAN' : 'PLAN (implement, addressing the changes above)';
  return (
    header +
    `Rules: work directly on the branch already checked out in the worktree (bureau-wt-${task.id}); do not create, switch, or rename branches; add the tests the plan names; ` +
    'when done, finish with a walkthrough section summarizing what changed, the ' +
    'test results, and the verification you ran.\n\n' +
    '===== TASK =====\n' +
    `TITLE: ${task.title}\n` +
    (projectInfo ? `PROJECT: ${projectInfo.name} (${projectInfo.path})\n` : '') +
    (task.intent ? `INTENT: ${task.intent}\n` : '') +
    (task.spec ? `SPEC: ${task.spec}\n` : '') +
    (task.acceptance ? `ACCEPTANCE: ${task.acceptance}\n` : '') +
    feedbackBlock +
    `\n===== ${planLabel} =====\n${planText}\n\n${JUNIOR_COMPLETION_INSTRUCTION}`
  );
}

function readSeniorStallRetries(db: DbConnection): number {
  const envVal = process.env['SENIOR_STALL_RETRIES'];
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.SENIOR_STALL_RETRIES
  );
  const n = row ? parseInt(row.value, 10) : DEFAULT_SENIOR_STALL_RETRIES;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SENIOR_STALL_RETRIES;
}

function readCeiling(db: DbConnection): number {
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.REVIEW_PLAN_ROUNDS_CEILING
  );
  return row ? parseInt(row.value, 10) : DEFAULT_PLAN_ROUNDS_CEILING;
}

export async function runPlanReviewCycle(
  db: DbConnection,
  opts: PlanCycleOptions
): Promise<PlanCycleResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', opts.taskId);
  if (!task) throw new Error(`Task '${opts.taskId}' not found in bureau_tasks`);

  const ceiling = readCeiling(db);
  const notify = (reason: string) => notifyOperator(opts.jobId ?? 'plan.cycle', reason);

  // ---- 0a. State gate: only queued/claimed tasks may plan -----------------
  if (task.state !== 'queued' && task.state !== 'claimed') {
    journal(db, {
      kind: 'guardrail',
      attribution: SENIOR_RUBRIC_ATTRIBUTION,
      taskId: task.id,
      jobId: opts.jobId ?? null,
      detail: { action: 'plan_cycle_state_refusal', taskState: task.state }
    });
    notify(`Task ${task.id} plan cycle refused: state is '${task.state}', not queued/claimed`);
    return { outcome: 'refused', reason: 'state', roundsUsed: task.plan_rounds, ceiling };
  }

  // ---- 0b. Ceiling entry-guard (legacy A-2, ported): refuse BEFORE any
  // junior or senior work — no unbounded rounds against live agents. (A
  // blocked task was already refused by the state gate above.)
  if (task.plan_rounds >= ceiling) {
    journal(db, {
      kind: 'guardrail',
      attribution: SENIOR_RUBRIC_ATTRIBUTION,
      taskId: task.id,
      jobId: opts.jobId ?? null,
      detail: {
        action: 'plan_cycle_ceiling_exceeded',
        plan_rounds: task.plan_rounds,
        ceiling,
        taskState: task.state
      }
    });
    if (task.state === 'claimed') {
      transition(db, task.id, 'blocked', SENIOR_RUBRIC_ATTRIBUTION, {
        reason: 'plan_rounds_ceiling_exceeded'
      });
    }
    notify(`Task ${task.id} plan cycle ceiling (${ceiling}) reached`);
    return { outcome: 'refused', reason: 'ceiling', roundsUsed: task.plan_rounds, ceiling };
  }

  const nowIso = new Date().toISOString();

  let folder = opts.folder;
  let projectInfo: { name: string; path: string } | undefined;
  if (task.project_id) {
    const proj = db.get<{ name: string; path_to_repo: string }>('SELECT name, path_to_repo FROM bureau_projects WHERE id = ?', task.project_id);
    if (proj) {
      projectInfo = { name: proj.name, path: proj.path_to_repo };
      if (!folder) {
        folder = proj.path_to_repo;
      }
    }
  }
  const effectiveOpts: PlanCycleOptions = { ...opts, folder };

  // ---- 1. Junior AUTHORS the plan -----------------------------------------
  // No junior pinned → the assignment policy (deterministic by task id), never
  // a hardcoded one: two concurrent tasks must land on different juniors (N3).
  const juniorId = (opts.junior || assignJunior({ taskId: task.id })).toUpperCase();
  const juniorAttribution: AttributionTuple = {
    actor_role: 'junior-engineer',
    provider: 'antigravity',
    model: opts.juniorModel || UNSPECIFIED_MODEL,
    account: null
  };

  const ag = getAntigravityDriver();
  const juniorPrompt = buildJuniorPlanPrompt(task, opts.priorFeedback, projectInfo);

  // N11: plan authoring serializes on the per-junior window lease, exactly like
  // junior.dispatch (`window-${juniorId}`). Two same-junior cycles that both
  // cold-launched the IDE produced TWO windows for one junior and a cold-start
  // attach collision — the operator-observed RAM waste and the dead-cycle scar.
  // WAIT for the window (bounded; the holder heartbeats, and a dead holder's
  // lease expires and becomes acquirable), then hold it with a heartbeat for
  // the whole authoring run.
  const authoringWindow = `window-${juniorId}`;
  let waitedForLease = false;
  const authoringLease = await waitForWindowLease(
    db,
    authoringWindow,
    `plan.cycle:${task.id}`,
    juniorAttribution,
    {
      waitMs: opts.juniorLeaseWaitMs ?? DEFAULT_AUTHORING_LEASE_WAIT_MS,
      pollMs: 250,
      signal: opts.signal,
      onWait: () => { waitedForLease = true; }
    }
  );
  const authoringHeartbeat = startWindowLeaseHeartbeat(db, authoringLease.id);
  journal(db, {
    kind: 'system',
    attribution: juniorAttribution,
    taskId: task.id,
    workUuid: task.work_uuid,
    jobId: opts.jobId ?? null,
    detail: {
      action: 'plan_authoring_window_lease_acquired',
      windowTarget: authoringWindow,
      leaseId: authoringLease.id,
      waited: waitedForLease
    }
  });

  let jr: AntigravityRunResult;
  try {
    jr = await ag.runCommand(juniorPrompt, {
      junior: juniorId,
      model: opts.juniorModel,
      folder: effectiveOpts.folder,
      stallMs: opts.juniorStallMs ?? 120000,
      // Round 1 must start fresh (no other task's context). A REVISE round
      // (priorFeedback present) is the SAME task continuing: stay in the junior's
      // existing conversation so it sees its prior plan + the senior's required
      // changes — and so we don't depend on a reset control the IDE may not expose.
      freshConversation: !opts.priorFeedback,
      signal: opts.signal
    });
  } finally {
    authoringHeartbeat.stop();
    releaseLease(db, authoringLease.id);
  }
  // Choose the richest plan text. This junior often emits "Key Plan Highlights"
  // inline and the full plan in an artifact file, so a narrow marker block can
  // miss the branch/scope/tests the rubric checks for. Prefer, in order: a
  // marker-extracted plan; the junior's full reply region (sliced after our
  // prompt, so the echoed task text can't masquerade as the plan); the reply.
  const replyRegion = jr.fullOutput ? sliceAfterPrompt(jr.fullOutput, juniorPrompt).trim() : '';
  const planText =
    [replyRegion, jr.plan, jr.transcript]
      .map(s => (s || '').trim())
      .find(s => s.length > 0) || '(junior produced no plan text)';
  // Honest attribution: the GUI picker read-back when a model was selected.
  juniorAttribution.model = jr.model ?? opts.juniorModel ?? UNSPECIFIED_MODEL;

  const planId = crypto.randomUUID();
  db.run(
    `INSERT INTO bureau_plans (id, task_id, work_uuid, round, status, plan_text, actor_role, provider, model, account, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    planId,
    task.id,
    task.work_uuid,
    task.plan_rounds ?? 0,
    planText,
    juniorAttribution.actor_role,
    juniorAttribution.provider,
    juniorAttribution.model,
    juniorAttribution.account,
    nowIso,
    nowIso
  );
  journal(db, {
    kind: 'observation',
    attribution: juniorAttribution,
    taskId: task.id,
    workUuid: task.work_uuid,
    jobId: opts.jobId ?? null,
    detail: { source: 'antigravity', stage: 'plan-authoring', junior: jr.junior ?? juniorId, planId }
  });

  // ---- 2. Cheap deterministic gate BEFORE any senior tokens ----------------
  // A plan missing the department standard (branch/scope/tests+mutations/
  // walkthrough) — including a junk fallback transcript — is amended by the
  // rubric, and the cycle loops; the senior is never billed for garbage.
  const rubric = evaluatePlanRubric(planText);
  if (!rubric.ok) {
    const feedback = `Deterministic rubric failure: missing ${rubric.missing.join(', ')}`;
    return finishReviseRound(db, task, {
      planId,
      planText,
      junior: jr.junior ?? juniorId,
      by: 'rubric',
      feedback,
      reviewAttribution: SENIOR_RUBRIC_ATTRIBUTION,
      reviewProvider: 'deterministic',
      reviewModel: 'rubric',
      juniorProvider: juniorAttribution.provider,
      juniorModel: juniorAttribution.model,
      ceiling,
      carry: effectiveOpts,
      jobId: opts.jobId
    });
  }

  // ---- 3. Senior REVIEWS the plan (with the task verbatim) -----------------
  const seniorId = opts.seniorId ?? assignSeniorForTask(task.id);
  const senior = getSeniorDriver(seniorId);
  const maxRetries = readSeniorStallRetries(db);
  let review: Awaited<ReturnType<typeof senior.review>> | null = null;
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts++;
    try {
      review = await senior.review({
        kind: 'plan',
        taskTitle: task.title,
        taskIntent: task.intent ?? undefined,
        taskSpec: task.spec ?? undefined,
        taskAcceptance: task.acceptance ?? undefined,
        projectName: projectInfo?.name,
        projectPath: projectInfo?.path,
        plan: planText,
        model: opts.seniorModel,
        // Round 1 (no prior feedback) starts a fresh senior conversation; retries (attempt > 1)
        // start fresh to clear any stuck conversation state; otherwise reuse context.
        freshConversation: attempts > 1 ? true : !opts.priorFeedback
      });
      break;
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempts <= maxRetries) {
        journal(db, {
          kind: 'guardrail',
          attribution: SENIOR_RUBRIC_ATTRIBUTION,
          taskId: task.id,
          workUuid: task.work_uuid,
          jobId: opts.jobId ?? null,
          detail: {
            action: 'senior_review_retry',
            stage: 'plan-review',
            senior: seniorId,
            attempt: attempts,
            maxRetries,
            error: errorMsg
          }
        });
      } else {
        const exhaustionAttribution: AttributionTuple = {
          actor_role: 'senior-engineer',
          provider: seniorId,
          model: opts.seniorModel ?? UNSPECIFIED_MODEL,
          account: null
        };
        journal(db, {
          kind: 'guardrail',
          attribution: exhaustionAttribution,
          taskId: task.id,
          workUuid: task.work_uuid,
          jobId: opts.jobId ?? null,
          detail: {
            action: 'senior_stall_exhausted',
            stage: 'plan-review',
            senior: seniorId,
            attempts,
            error: errorMsg
          }
        });
        const refreshed = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', task.id);
        if (refreshed) {
          if (refreshed.state === 'queued') {
            transition(db, task.id, 'claimed', exhaustionAttribution, {
              reason: 'senior_stall_exhaustion_claim'
            });
            transition(db, task.id, 'blocked', exhaustionAttribution, {
              reason: 'senior_stall_exhausted',
              attempts
            });
          } else if (refreshed.state === 'claimed') {
            transition(db, task.id, 'blocked', exhaustionAttribution, {
              reason: 'senior_stall_exhausted',
              attempts
            });
          }
        }
        notifyOperator(
          opts.jobId ?? 'plan.cycle',
          `Task ${task.id} plan senior review stalled/failed after ${attempts} attempt(s) (${seniorId}) — ` +
            `blocked for operator re-arm`
        );
        return {
          outcome: 'blocked',
          reason: 'senior_stall_exhausted',
          senior: seniorId,
          attempts
        };
      }
    }
  }

  if (!review) {
    throw new Error(`Unexpected state: senior review missing after retry loop for task ${task.id}`);
  }

  if (review.verdict === 'approve') {
    return finishApproveRound(db, task, {
      planId,
      planText,
      junior: jr.junior ?? juniorId,
      seniorId,
      seniorLabel: review.senior,
      seniorModel: review.model ?? opts.seniorModel ?? UNSPECIFIED_MODEL,
      feedback: review.feedback,
      juniorProvider: juniorAttribution.provider,
      juniorModel: juniorAttribution.model,
      ceiling,
      carry: effectiveOpts
    });
  }

  return finishReviseRound(db, task, {
    planId,
    planText,
    junior: jr.junior ?? juniorId,
    by: 'senior',
    seniorId,
    feedback: review.feedback,
    reviewAttribution: {
      actor_role: 'senior-engineer',
      provider: seniorId,
      model: review.model ?? opts.seniorModel ?? UNSPECIFIED_MODEL,
      account: null
    },
    reviewProvider: seniorId,
    reviewModel: review.model ?? opts.seniorModel ?? UNSPECIFIED_MODEL,
    juniorProvider: juniorAttribution.provider,
    juniorModel: juniorAttribution.model,
    ceiling,
    carry: effectiveOpts,
    jobId: opts.jobId
  });
}

// ---------------------------------------------------------------------------
// Round completion — shared bookkeeping for the verdict paths
// ---------------------------------------------------------------------------

interface ApproveParams {
  planId: string;
  planText: string;
  junior: string;
  seniorId: string;
  seniorLabel: string;
  seniorModel: string;
  feedback: string;
  juniorProvider: string;
  juniorModel: string;
  ceiling: number;
  carry: PlanCycleOptions;
}

function finishApproveRound(db: DbConnection, task: BureauTaskRow, p: ApproveParams): PlanCycleResult {
  const nowIso = new Date().toISOString();
  const dbVerdict = 'approved';
  const seniorAttribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: p.seniorId,
    model: p.seniorModel,
    account: null
  };

  const dispatchId = crypto.randomUUID();
  const implPrompt = buildImplementationPrompt(task, p.planText, {
    approved: true,
    feedback: p.feedback
  });

  const dispatchJob = db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_plan_reviews (id, plan_id, task_id, verdict, feedback, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      p.planId,
      task.id,
      dbVerdict,
      p.feedback,
      seniorAttribution.actor_role,
      seniorAttribution.provider,
      seniorAttribution.model,
      seniorAttribution.account,
      nowIso
    );
    db.run(`UPDATE bureau_plans SET status = ?, updated_at = ? WHERE id = ?`, dbVerdict, nowIso, p.planId);
    db.run(
      `UPDATE bureau_tasks SET plan_rounds = plan_rounds + 1, updated_at = ? WHERE id = ?`,
      nowIso,
      task.id
    );
    // The task leaves the planning queue: an approved plan claims it. Without this
    // the task sat in `queued` forever even though implementation was dispatched
    // (the zombie the first real run exposed). queued→claimed is the legal edge.
    if (task.state === 'queued') {
      transition(db, task.id, 'claimed', seniorAttribution, { reason: 'plan_approved' });
    }
    journal(db, {
      kind: 'review',
      attribution: seniorAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: p.carry.jobId ?? null,
      detail: { stage: 'plan-review', senior: p.seniorId, verdict: dbVerdict, planId: p.planId }
    });

    // Legacy A-7a continuation, on the harness path: an approved plan immediately
    // becomes a real dispatch row + job for the SAME junior who planned it.
    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
       VALUES (?, ?, ?, 'junior-engineer', ?, ?, NULL, 'pending', ?)`,
      dispatchId,
      task.id,
      task.work_uuid,
      p.juniorProvider,
      p.juniorModel,
      nowIso
    );
    return enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: task.id,
      payload: {
        dispatchId,
        prompt: implPrompt,
        junior: p.junior,
        // Continue in the planning conversation (see enqueueImplementationDispatch).
        freshConversation: false,
        // When the implementation finishes, the senior must READ THE WALKTHROUGH:
        // chain a work-review cycle so the flow reaches a review, not a dead end.
        chainWorkReview: true,
        // Pin the model the planning round actually used, when it is known —
        // never pin the 'unspecified' sentinel.
        ...(p.juniorModel !== UNSPECIFIED_MODEL ? { model: p.juniorModel } : {}),
        ...(p.carry.folder ? { folder: p.carry.folder } : {})
      }
    });
  });

  return {
    outcome: 'approved',
    planId: p.planId,
    planText: p.planText,
    junior: p.junior,
    senior: p.seniorId,
    feedback: p.feedback,
    roundsUsed: task.plan_rounds + 1,
    ceiling: p.ceiling,
    dispatchJobId: dispatchJob.id
  };
}

/**
 * Kick the junior's implementation: insert a dispatch row and enqueue
 * junior.dispatch with the given plan as the implementation prompt. Shared by the
 * approve path and the ceiling-proceed path so both drive the SAME junior that
 * planned, in its GUI, on the recorded plan.
 */
function enqueueImplementationDispatch(
  db: DbConnection,
  task: BureauTaskRow,
  opts: {
    planText: string;
    junior: string;
    juniorProvider: string;
    juniorModel: string;
    folder?: string;
    /** Honest basis for the prompt header — the ceiling path is NOT an approval. */
    basis: ImplementationBasis;
  }
) {
  const nowIso = new Date().toISOString();
  const dispatchId = crypto.randomUUID();
  const implPrompt = buildImplementationPrompt(task, opts.planText, opts.basis);
  db.run(
    `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
     VALUES (?, ?, ?, 'junior-engineer', ?, ?, NULL, 'pending', ?)`,
    dispatchId,
    task.id,
    task.work_uuid,
    opts.juniorProvider,
    opts.juniorModel,
    nowIso
  );
  return enqueueJob(db, {
    kind: 'junior.dispatch',
    task_id: task.id,
    payload: {
      dispatchId,
      prompt: implPrompt,
      junior: opts.junior,
      // Continue in the planning conversation: the junior already holds its
      // approved plan + the senior's review, and the IDE may expose no reset.
      freshConversation: false,
      // The walkthrough must still be reviewed — chain the work-review cycle.
      chainWorkReview: true,
      ...(opts.juniorModel !== UNSPECIFIED_MODEL ? { model: opts.juniorModel } : {}),
      ...(opts.folder ? { folder: opts.folder } : {})
    }
  });
}

interface ReviseParams {
  planId: string;
  planText: string;
  junior: string;
  by: 'senior' | 'rubric';
  seniorId?: string;
  feedback: string;
  reviewAttribution: AttributionTuple;
  reviewProvider: string;
  reviewModel: string;
  /** The junior that authored this plan — carried so the ceiling-proceed path can
   *  dispatch the SAME junior to implement. */
  juniorProvider: string;
  juniorModel: string;
  ceiling: number;
  carry: CycleCarry & { jobId?: string };
  jobId?: string;
}

function finishReviseRound(db: DbConnection, task: BureauTaskRow, p: ReviseParams): PlanCycleResult {
  const nowIso = new Date().toISOString();
  const dbVerdict = 'amend';

  db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_plan_reviews (id, plan_id, task_id, verdict, feedback, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      p.planId,
      task.id,
      dbVerdict,
      p.feedback,
      p.reviewAttribution.actor_role,
      p.reviewProvider,
      p.reviewModel,
      p.reviewAttribution.account,
      nowIso
    );
    db.run(`UPDATE bureau_plans SET status = ?, updated_at = ? WHERE id = ?`, dbVerdict, nowIso, p.planId);
    db.run(
      `UPDATE bureau_tasks SET plan_rounds = plan_rounds + 1, updated_at = ? WHERE id = ?`,
      nowIso,
      task.id
    );
    journal(db, {
      kind: 'review',
      attribution: p.reviewAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: p.jobId ?? null,
      detail: { stage: 'plan-review', by: p.by, senior: p.seniorId ?? 'rubric', verdict: dbVerdict, planId: p.planId }
    });
  });

  const roundsUsed = task.plan_rounds + 1;

  // The cycle actually cycles: with rounds remaining, the senior's feedback is
  // fed straight back to the junior in the next round. At the ceiling, rather
  // than stall the task, the department lets the junior START implementing on the
  // best-available plan and moves the quality gate to the WALKTHROUGH review
  // (senior.review-work) after the work exists — "see the whole flow through".
  // The plan history and every amend verdict remain on the record for that
  // review, so nothing is silently waved through.
  if (roundsUsed >= p.ceiling) {
    // The task leaves the planning queue and starts implementing on the
    // best-available plan — the walkthrough review is the compensating gate.
    if (task.state === 'queued') {
      transition(db, task.id, 'claimed', p.reviewAttribution, {
        reason: 'plan_ceiling_proceed_to_implementation'
      });
    }
    const dispatchJob = enqueueImplementationDispatch(db, task, {
      planText: p.planText,
      junior: p.junior,
      juniorProvider: p.juniorProvider,
      juniorModel: p.juniorModel,
      folder: p.carry.folder,
      // Honest: this is the ceiling path, not an approval — thread the final
      // feedback so the junior implements against the outstanding required changes.
      basis: { approved: false, feedback: p.feedback, roundsUsed, ceiling: p.ceiling }
    });
    journal(db, {
      kind: 'review',
      attribution: p.reviewAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: p.jobId ?? null,
      detail: {
        stage: 'plan-review',
        action: 'ceiling_proceed_to_implementation',
        ceiling: p.ceiling,
        roundsUsed,
        planId: p.planId,
        dispatchJobId: dispatchJob.id
      }
    });
    notifyOperator(
      p.jobId ?? 'plan.cycle',
      `Task ${task.id} hit the plan ceiling (${p.ceiling}); the junior started implementing — the walkthrough review is now the gate`
    );
    return {
      outcome: 'revise',
      planId: p.planId,
      planText: p.planText,
      junior: p.junior,
      by: p.by,
      senior: p.seniorId,
      feedback: p.feedback,
      roundsUsed,
      ceiling: p.ceiling,
      nextRoundEnqueued: false,
      ceilingDispatchJobId: dispatchJob.id
    };
  }

  const next = enqueueJob(db, {
    kind: 'plan.cycle',
    task_id: task.id,
    payload: {
      taskId: task.id,
      priorFeedback: p.feedback,
      junior: p.junior,
      ...(p.carry.seniorId ? { seniorId: p.carry.seniorId } : {}),
      ...(p.carry.juniorModel ? { juniorModel: p.carry.juniorModel } : {}),
      ...(p.carry.seniorModel ? { seniorModel: p.carry.seniorModel } : {}),
      ...(p.carry.folder ? { folder: p.carry.folder } : {}),
      ...(p.carry.juniorStallMs ? { juniorStallMs: p.carry.juniorStallMs } : {})
    },
    // One attempt per round: a failed round surfaces to the operator instead of
    // re-prompting the live GUI agents (duplicate conversations, duplicate cost).
    max_attempts: 1
  });

  return {
    outcome: 'revise',
    planId: p.planId,
    planText: p.planText,
    junior: p.junior,
    by: p.by,
    senior: p.seniorId,
    feedback: p.feedback,
    roundsUsed,
    ceiling: p.ceiling,
    nextRoundEnqueued: true
  };
}
