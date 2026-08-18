import {
  DEFAULT_PLAN_ROUNDS_CEILING,
  REVIEW_PR_META_KEYS
} from '../contract/constants.ts';
import type {
  AttributionTuple,
  BureauPlanRow,
  BureauTaskRow,
  JobContext
} from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { callModel, getCandidateModels } from '../llm/call_model.ts';
import { getAssignment, getModel } from '../models/registry.ts';
import { transition } from '../state/machine.ts';
import { notifyOperator } from '../state/notifications.ts';
import { enqueueJob } from '../jobs/jobs.ts';

export const SENIOR_RUBRIC_ATTRIBUTION: AttributionTuple = {
  actor_role: 'senior-engineer',
  provider: 'deterministic',
  model: 'rubric',
  account: null
};

export interface PlanRubricResult {
  ok: boolean;
  missing: string[];
}

export function evaluatePlanRubric(planText: string): PlanRubricResult {
  const missing: string[] = [];

  // 1. Branch named
  if (!/wt\/|branch/i.test(planText)) {
    missing.push('branch name (wt/...)');
  }

  // 2. Scope enumerable
  if (!/scope|component|files|proposed changes/i.test(planText)) {
    missing.push('enumerable scope / components');
  }

  // 3. Tests and mutations named
  const hasTests = /tests?/i.test(planText);
  const hasMutations = /mutation/i.test(planText);
  if (!hasTests || !hasMutations) {
    missing.push('tests and mutation evidence');
  }

  // 4. Walkthrough planned
  if (!/walkthrough|verification plan/i.test(planText)) {
    missing.push('walkthrough / verification plan');
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

export interface SeniorReviewPlanPayload {
  taskId: string;
  planId?: string;
}

export async function handleSeniorReviewPlan(ctx: JobContext): Promise<void> {
  const payload = ctx.payload as SeniorReviewPlanPayload;
  if (!payload || !payload.taskId) {
    throw new Error("senior.review-plan job missing required payload 'taskId'");
  }

  const task = ctx.db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', payload.taskId);
  if (!task) {
    throw new Error(`Task '${payload.taskId}' not found in bureau_tasks`);
  }

  // Read plan rounds ceiling from meta
  const ceilingRow = ctx.db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.REVIEW_PLAN_ROUNDS_CEILING
  );
  const ceiling = ceilingRow ? parseInt(ceilingRow.value, 10) : DEFAULT_PLAN_ROUNDS_CEILING;

  // A-2: Ceiling Entry-Guard — check at job entry before any rubric or model work
  if (task.state === 'blocked' || task.plan_rounds >= ceiling) {
    journal(ctx.db, {
      kind: 'guardrail',
      attribution: SENIOR_RUBRIC_ATTRIBUTION,
      taskId: task.id,
      jobId: ctx.job.id,
      detail: {
        action: 'plan_review_ceiling_exceeded',
        plan_rounds: task.plan_rounds,
        ceiling,
        taskState: task.state
      }
    });

    if (task.state === 'claimed' && task.plan_rounds >= ceiling) {
      transition(ctx.db, task.id, 'blocked', SENIOR_RUBRIC_ATTRIBUTION, {
        reason: 'plan_rounds_ceiling_exceeded'
      });
      notifyOperator(ctx.job.id, `Task ${task.id} plan review ceiling (${ceiling}) reached`);
    }

    return;
  }

  // Fetch plan
  let plan: BureauPlanRow | undefined;
  if (payload.planId) {
    plan = ctx.db.get<BureauPlanRow>('SELECT * FROM bureau_plans WHERE id = ?', payload.planId);
  } else {
    plan = ctx.db.get<BureauPlanRow>(
      'SELECT * FROM bureau_plans WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      task.id
    );
  }

  if (!plan) {
    throw new Error(`No plan found for task '${task.id}'`);
  }

  const nowIso = new Date().toISOString();

  // 1. Cheap Gate: Deterministic Rubric Check
  const rubric = evaluatePlanRubric(plan.plan_text);

  if (!rubric.ok) {
    // Rubric Refusal — Zero token cost, guardrail span logged, model NOT called
    journal(ctx.db, {
      kind: 'guardrail',
      attribution: SENIOR_RUBRIC_ATTRIBUTION,
      taskId: task.id,
      jobId: ctx.job.id,
      detail: {
        action: 'plan_rubric_refusal',
        missing: rubric.missing
      }
    });

    const feedback = `Deterministic rubric failure: missing ${rubric.missing.join(', ')}`;
    const reviewId = crypto.randomUUID();

    ctx.db.execTransaction(() => {
      ctx.db.run(
        `INSERT INTO bureau_plan_reviews (id, plan_id, task_id, verdict, feedback, actor_role, provider, model, account, created_at)
         VALUES (?, ?, ?, 'amend', ?, 'senior-engineer', 'deterministic', 'rubric', NULL, ?)`,
        reviewId,
        plan.id,
        task.id,
        feedback,
        nowIso
      );

      ctx.db.run(
        `UPDATE bureau_tasks SET plan_rounds = plan_rounds + 1, updated_at = ? WHERE id = ?`,
        nowIso,
        task.id
      );

      ctx.db.run(
        `UPDATE bureau_plans SET status = 'amend', updated_at = ? WHERE id = ?`,
        nowIso,
        plan.id
      );

      journal(ctx.db, {
        kind: 'review',
        attribution: SENIOR_RUBRIC_ATTRIBUTION,
        taskId: task.id,
        jobId: ctx.job.id,
        detail: {
          verdict: 'amend',
          feedback,
          plan_rounds: task.plan_rounds + 1
        }
      });
    });

    const newPlanRounds = task.plan_rounds + 1;
    if (newPlanRounds >= ceiling) {
      const refreshed = ctx.db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', task.id);
      if (refreshed && refreshed.state === 'claimed') {
        transition(ctx.db, task.id, 'blocked', SENIOR_RUBRIC_ATTRIBUTION, {
          reason: 'plan_rounds_ceiling_exceeded_after_rubric_refusal'
        });
      }
      notifyOperator(ctx.job.id, `Task ${task.id} plan review ceiling (${ceiling}) reached`);
    }

    return;
  }

  // 2. Model Review Gate (Rubric Passed)
  const systemPrompt =
    'You are a Senior Engineer reviewing a technical implementation plan for a task in the bureau. ' +
    'Evaluate the plan against the task title, spec, and acceptance criteria. ' +
    'Respond with a JSON object containing "verdict" ("approved" or "amend") and "feedback" (string).';

  const userPrompt =
    `Task Title: ${task.title}\n` +
    `Intent: ${task.intent ?? 'N/A'}\n` +
    `Spec: ${task.spec ?? 'N/A'}\n` +
    `Acceptance: ${task.acceptance ?? 'N/A'}\n\n` +
    `Plan Text:\n${plan.plan_text}\n\n` +
    'Provide your review decision in JSON format: {"verdict": "approved" | "amend", "feedback": "reasoning"}';

  const completion = await callModel(
    ctx.db,
    'senior-engineer',
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    undefined,
    {
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: ctx.job.id,
      signal: ctx.signal
    }
  );
  const reviewId = crypto.randomUUID();
  let verdict: 'approved' | 'amend' = 'amend';
  let feedback = 'Unparseable Senior model response; defaulting to amend';

  try {
    const parsed = JSON.parse(completion.text ?? '{}');
    if (parsed.verdict === 'approved') {
      verdict = 'approved';
    } else if (parsed.verdict === 'amend') {
      verdict = 'amend';
    }
    if (typeof parsed.feedback === 'string' && parsed.feedback.length > 0) {
      feedback = parsed.feedback;
    }
  } catch {
    if (completion.text && completion.text.length > 0) {
      feedback = completion.text;
    }
  }

  const modelAttribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: completion.provider ?? 'mock',
    model: completion.model ?? 'mock-model',
    account: (completion as any).account ?? null
  };

  ctx.db.execTransaction(() => {
    ctx.db.run(
      `INSERT INTO bureau_plan_reviews (id, plan_id, task_id, verdict, feedback, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, ?, ?, 'senior-engineer', ?, ?, ?, ?)`,
      reviewId,
      plan?.id ?? null,
      task.id,
      verdict,
      feedback,
      modelAttribution.provider,
      modelAttribution.model,
      modelAttribution.account,
      nowIso
    );

    ctx.db.run(
      `UPDATE bureau_tasks SET plan_rounds = plan_rounds + 1, updated_at = ? WHERE id = ?`,
      nowIso,
      task.id
    );

    journal(ctx.db, {
      kind: 'review',
      attribution: modelAttribution,
      taskId: task.id,
      jobId: ctx.job.id,
      detail: {
        action: 'senior_plan_review',
        verdict,
        plan_rounds: task.plan_rounds + 1
      }
    });

    // A-7a: Enqueue junior.dispatch on plan approval with accurate model provenance (Finding 4)
    if (verdict === 'approved') {
      const juniorAssignment = getAssignment(ctx.db, 'junior-engineer');
      let juniorModelRow = juniorAssignment?.model_id ? getModel(ctx.db, juniorAssignment.model_id) : null;
      if (!juniorModelRow) {
        const candidates = getCandidateModels(ctx.db, 'junior-engineer');
        juniorModelRow = candidates[0] ?? null;
      }

      const juniorProvider = juniorModelRow?.provider ?? 'ollama';
      const juniorModel = juniorModelRow?.id ?? 'qwen2.5-coder';

      let dispatchId = crypto.randomUUID();
      ctx.db.run(
        `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
         VALUES (?, ?, ?, 'junior-engineer', ?, ?, NULL, 'pending', ?)`,
        dispatchId,
        task.id,
        task.work_uuid,
        juniorProvider,
        juniorModel,
        nowIso
      );

      enqueueJob(ctx.db, {
        kind: 'junior.dispatch',
        task_id: task.id,
        payload: { dispatchId }
      });
    }
  });

  const newPlanRounds = task.plan_rounds + 1;
  if (verdict === 'amend' && newPlanRounds >= ceiling) {
    const refreshed = ctx.db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', task.id);
    if (refreshed && refreshed.state === 'claimed') {
      transition(ctx.db, task.id, 'blocked', modelAttribution, {
        reason: 'plan_rounds_ceiling_exceeded_after_model_amend'
      });
    }
    notifyOperator(ctx.job.id, `Task ${task.id} plan review ceiling (${ceiling}) reached`);
  }
}
