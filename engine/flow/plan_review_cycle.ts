import crypto from 'node:crypto';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { getAntigravityDriver } from '../harness/antigravity-seam.ts';
import { getSeniorDriver } from '../harness/senior-seam.ts';
import { assignSenior } from '../harness/senior.ts';

/**
 * Plan-review cycle — the corrected department flow for the planning stage:
 *
 *   TASK  →  junior AUTHORS the plan  →  senior REVIEWS the plan (with the task
 *   verbatim)  →  approve | revise.
 *
 * The junior (an Antigravity agent) is asked for a plan ONLY — no code yet. The
 * senior (Claude CLI or ZCode/GLM) is handed the plan together with the task
 * verbatim (title + intent + spec + acceptance) so it can judge whether the plan
 * actually satisfies the task. Both steps write real DB rows (`bureau_plans`,
 * `bureau_plan_reviews`) and attributed journal spans, so this is the department's
 * flow, not a side channel.
 */

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
  /** How long to wait for the junior to author the plan (ms). Planning is slower
   *  than a one-line reply, so this defaults high. */
  juniorWaitMs?: number;
}

export interface PlanCycleResult {
  planId: string;
  planText: string;
  junior: string;
  senior: string;
  verdict: 'approve' | 'revise';
  feedback: string;
}

/**
 * Hand the junior the task and let it plan in its own way — Antigravity produces
 * an implementation plan for a task regardless, so we don't dictate the format.
 * The only constraint: plan first, don't write code yet (a senior reviews first).
 */
export function buildJuniorPlanPrompt(task: BureauTaskRow): string {
  return (
    'Here is a task for you to plan. Do NOT write any code yet — a senior will ' +
    'review your implementation plan first.\n\n' +
    '===== TASK =====\n' +
    `TITLE: ${task.title}\n` +
    (task.intent ? `INTENT: ${task.intent}\n` : '') +
    (task.spec ? `SPEC: ${task.spec}\n` : '') +
    (task.acceptance ? `ACCEPTANCE: ${task.acceptance}\n` : '')
  );
}

export async function runPlanReviewCycle(
  db: DbConnection,
  opts: PlanCycleOptions
): Promise<PlanCycleResult> {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', opts.taskId);
  if (!task) throw new Error(`Task '${opts.taskId}' not found in bureau_tasks`);

  const nowIso = new Date().toISOString();

  // ---- 1. Junior AUTHORS the plan -----------------------------------------
  const juniorId = (opts.junior || 'A').toUpperCase();
  const juniorAttribution: AttributionTuple = {
    actor_role: 'junior-engineer',
    provider: 'antigravity',
    model: opts.juniorModel || `junior-${juniorId}`,
    account: null
  };

  const ag = getAntigravityDriver();
  const jr = await ag.runCommand(buildJuniorPlanPrompt(task), {
    junior: juniorId,
    model: opts.juniorModel,
    folder: opts.folder,
    waitMs: opts.juniorWaitMs ?? 25000
  });
  const planText = (jr.plan && jr.plan.trim()) || jr.transcript || '(junior produced no plan text)';

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
    detail: { source: 'antigravity', stage: 'plan-authoring', junior: jr.junior ?? juniorId, planId }
  });

  // ---- 2. Senior REVIEWS the plan (with the task verbatim) ----------------
  const seniorId = opts.seniorId ?? assignSenior({ kind: 'plan' });
  const senior = getSeniorDriver(seniorId);
  const review = await senior.review({
    kind: 'plan',
    taskTitle: task.title,
    taskIntent: task.intent ?? undefined,
    taskSpec: task.spec ?? undefined,
    taskAcceptance: task.acceptance ?? undefined,
    plan: planText,
    model: opts.seniorModel
  });

  const dbVerdict = review.verdict === 'approve' ? 'approved' : 'amend';
  const seniorAttribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: seniorId,
    model: opts.seniorModel || review.senior,
    account: null
  };

  db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_plan_reviews (id, plan_id, task_id, verdict, feedback, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      planId,
      task.id,
      dbVerdict,
      review.feedback,
      seniorAttribution.actor_role,
      seniorAttribution.provider,
      seniorAttribution.model,
      seniorAttribution.account,
      nowIso
    );
    db.run(`UPDATE bureau_plans SET status = ?, updated_at = ? WHERE id = ?`, dbVerdict, nowIso, planId);
    db.run(
      `UPDATE bureau_tasks SET plan_rounds = plan_rounds + 1, updated_at = ? WHERE id = ?`,
      nowIso,
      task.id
    );
    journal(db, {
      kind: 'review',
      attribution: seniorAttribution,
      taskId: task.id,
      workUuid: task.work_uuid,
      detail: { stage: 'plan-review', senior: seniorId, verdict: dbVerdict, planId }
    });
  });

  return {
    planId,
    planText,
    junior: jr.junior ?? juniorId,
    senior: seniorId,
    verdict: review.verdict,
    feedback: review.feedback
  };
}
