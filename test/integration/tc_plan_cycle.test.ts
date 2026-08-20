import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { getJobDefinition, getRegisteredJobKinds } from '../../engine/jobs/registry.ts';
import {
  runPlanReviewCycle,
  buildJuniorPlanPrompt,
  buildImplementationPrompt
} from '../../engine/flow/plan_review_cycle.ts';

function seedTask(db: any, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, plan_rounds, created_at, updated_at)
     VALUES ('task-pc', 'Build a clicker', 'one button increments a number', 'single HTML page', 'clicking raises the count', ?, 'work-pc', ?, ?, ?)`,
    overrides['state'] ?? 'claimed',
    overrides['plan_rounds'] ?? 0,
    now,
    now
  );
}

/** A passing-plan shape: branch, scope, tests+mutation, walkthrough — satisfies the rubric. */
const GOOD_PLAN = [
  'Implementation Plan',
  'Branch: wt/junior-b-clicker',
  'Scope: index.html only (one button, counter span).',
  'Tests: t_clicker.test.ts asserts count rises; mutation: break the handler → test fails.',
  'Walkthrough: verify build + suite, then post results.'
].join('\n');

describe('Plan-review cycle — junior authors, rubric gates, senior reviews', () => {
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
  });

  it('buildJuniorPlanPrompt asks for a PLAN ONLY, states the standard, embeds the task verbatim, and relays prior feedback', () => {
    const task = {
      title: 'Build a clicker',
      intent: 'one button increments',
      spec: 'single HTML page',
      acceptance: 'count rises on click'
    } as any;
    const p = buildJuniorPlanPrompt(task);
    expect(p).toMatch(/Do NOT write any code/i);
    expect(p).toMatch(/wt\//i); // the plan standard the rubric will enforce
    expect(p).toMatch(/mutation/i);
    expect(p).toContain('Build a clicker');
    expect(p).toContain('one button increments');
    expect(p).toContain('count rises on click');

    const p2 = buildJuniorPlanPrompt(task, 'name the branch and add tests');
    expect(p2).toContain('PREVIOUS plan');
    expect(p2).toContain('name the branch and add tests');
  });

  it('buildImplementationPrompt carries the task verbatim AND the approved plan', () => {
    const p = buildImplementationPrompt({ title: 'Build a clicker' } as any, 'Branch: wt/x');
    expect(p).toMatch(/APPROVED/i);
    expect(p).toContain('Build a clicker');
    expect(p).toContain('Branch: wt/x');
    expect(p).toMatch(/walkthrough/i);
  });

  it('APPROVE: records plan + review rows, and CONTINUES the pipeline — dispatch row + junior.dispatch job with the approved plan', async () => {
    const db = createFakeDb();
    seedTask(db);

    let seniorSawTask = '';
    let seniorSawPlan = '';
    setAntigravityDriverOverride({
      runCommand: async () => ({ transcript: 'reply', plan: GOOD_PLAN, junior: 'B', launched: false, model: 'Gemini 3.7 Flash' })
    });
    setSeniorDriverOverride({
      review: async (input: any) => {
        seniorSawTask = input.taskTitle + '|' + (input.taskIntent ?? '') + '|' + (input.taskAcceptance ?? '');
        seniorSawPlan = input.plan;
        return { senior: 'claude', verdict: 'approve', feedback: 'aligned with task', raw: 'VERDICT: APPROVE', model: 'opus-test' };
      }
    });

    const res = await runPlanReviewCycle(db, { taskId: 'task-pc', junior: 'B', seniorId: 'claude' });
    expect(res.outcome).toBe('approved');

    // Senior received the junior's plan AND the task verbatim.
    expect(seniorSawPlan).toContain('wt/junior-b-clicker');
    expect(seniorSawTask).toContain('Build a clicker');
    expect(seniorSawTask).toContain('one button increments a number');

    // Plan row authored by the junior with HONEST model attribution.
    const plan = db.get<any>('SELECT * FROM bureau_plans WHERE id = ?', (res as any).planId);
    expect(plan.actor_role).toBe('junior-engineer');
    expect(plan.provider).toBe('antigravity');
    expect(plan.model).toBe('Gemini 3.7 Flash'); // picker read-back, not a placeholder
    expect(plan.status).toBe('approved');

    // Review row by the senior, model likewise.
    const review = db.get<any>('SELECT * FROM bureau_plan_reviews WHERE plan_id = ?', (res as any).planId);
    expect(review.verdict).toBe('approved');
    expect(review.actor_role).toBe('senior-engineer');
    expect(review.provider).toBe('claude');
    expect(review.model).toBe('opus-test');

    // plan_rounds incremented on the task.
    expect(db.get<any>('SELECT plan_rounds FROM bureau_tasks WHERE id = ?', 'task-pc').plan_rounds).toBe(1);

    // The continuation: a real dispatch row + a junior.dispatch job whose prompt
    // embeds the approved plan, targeted at the SAME junior who planned it.
    const dispatch = db.get<any>('SELECT * FROM bureau_dispatches WHERE task_id = ?', 'task-pc');
    expect(dispatch.provider).toBe('antigravity');
    expect(dispatch.model).toBe('Gemini 3.7 Flash');
    const job = db.get<any>('SELECT * FROM bureau_jobs WHERE id = ?', (res as any).dispatchJobId);
    expect(job.kind).toBe('junior.dispatch');
    expect(job.state).toBe('pending');
    const payload = JSON.parse(job.payload);
    expect(payload.dispatchId).toBe(dispatch.id);
    expect(payload.junior).toBe('B');
    expect(payload.prompt).toContain('wt/junior-b-clicker');
    expect(payload.prompt).toContain('Build a clicker');
  });

  it('REVISE: loops — next plan.cycle round is enqueued WITH the senior feedback, and the junior is told', async () => {
    const db = createFakeDb();
    seedTask(db);
    setAntigravityDriverOverride({
      runCommand: async () => ({ transcript: 'reply', plan: GOOD_PLAN, junior: 'A', launched: false })
    });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'zai', verdict: 'revise', feedback: 'narrow the scope to one file', raw: 'VERDICT: REVISE' })
    });

    const res = await runPlanReviewCycle(db, { taskId: 'task-pc', seniorId: 'zai' });
    expect(res.outcome).toBe('revise');
    expect((res as any).by).toBe('senior');
    expect((res as any).nextRoundEnqueued).toBe(true);

    // Amend review recorded.
    const review = db.get<any>('SELECT verdict FROM bureau_plan_reviews WHERE plan_id = ?', (res as any).planId);
    expect(review.verdict).toBe('amend');

    // Next round enqueued carrying the feedback.
    const next = db.get<any>(
      `SELECT * FROM bureau_jobs WHERE kind = 'plan.cycle' AND state = 'pending'`
    );
    expect(next).toBeTruthy();
    const payload = JSON.parse(next.payload);
    expect(payload.taskId).toBe('task-pc');
    expect(payload.priorFeedback).toContain('narrow the scope to one file');
    expect(next.max_attempts).toBe(1); // no automatic re-prompting of live agents

    // Round 2: the junior receives the senior's feedback verbatim.
    let juniorPrompt = '';
    setAntigravityDriverOverride({
      runCommand: async (prompt: string) => {
        juniorPrompt = prompt;
        return { transcript: 'reply', plan: GOOD_PLAN, junior: 'A', launched: false };
      }
    });
    const res2 = await runPlanReviewCycle(db, { taskId: 'task-pc', seniorId: 'zai', priorFeedback: payload.priorFeedback, junior: payload.junior });
    expect(res2.outcome).toBe('revise');
    expect(juniorPrompt).toContain('PREVIOUS plan');
    expect(juniorPrompt).toContain('narrow the scope to one file');
    expect(db.get<any>('SELECT plan_rounds FROM bureau_tasks WHERE id = ?', 'task-pc').plan_rounds).toBe(2);
  });

  it('CEILING entry-guard: at plan_rounds >= ceiling the cycle REFUSES — guardrail span, task blocked, no junior invoked', async () => {
    const db = createFakeDb();
    seedTask(db, { plan_rounds: 3 }); // default ceiling is 3

    let juniorRan = false;
    setAntigravityDriverOverride({
      runCommand: async () => {
        juniorRan = true;
        return { transcript: 'x', junior: 'A', launched: false };
      }
    });

    const res = await runPlanReviewCycle(db, { taskId: 'task-pc' });
    expect(res).toEqual({ outcome: 'refused', reason: 'ceiling', roundsUsed: 3, ceiling: 3 });
    expect(juniorRan).toBe(false); // refused BEFORE any agent work
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', 'task-pc').state).toBe('blocked');
    const guardrail = db.get<any>(
      `SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%plan_cycle_ceiling_exceeded%'`
    );
    expect(guardrail).toBeTruthy();
    // No plan was authored, no review recorded.
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_plans`).n).toBe(0);
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_plan_reviews`).n).toBe(0);
  });

  it('STATE gate: a task outside queued/claimed is refused with a guardrail span, nothing runs', async () => {
    const db = createFakeDb();
    seedTask(db, { state: 'verifying' });
    let juniorRan = false;
    setAntigravityDriverOverride({
      runCommand: async () => {
        juniorRan = true;
        return { transcript: 'x', junior: 'A', launched: false };
      }
    });
    const res = await runPlanReviewCycle(db, { taskId: 'task-pc' });
    expect(res).toEqual({ outcome: 'refused', reason: 'state', roundsUsed: 0, ceiling: 3 });
    expect(juniorRan).toBe(false);
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%plan_cycle_state_refusal%'`).n).toBe(1);
  });

  it('RUBRIC pre-gate: a plan missing the standard is amended deterministically — the senior is NOT billed', async () => {
    const db = createFakeDb();
    seedTask(db);
    setAntigravityDriverOverride({
      // No branch/tests/mutation/walkthrough — e.g. the transcript-fallback junk case.
      runCommand: async () => ({ transcript: 'sure, I will do it somehow', plan: '', junior: 'B', launched: false })
    });
    let seniorRan = false;
    setSeniorDriverOverride({
      review: async () => {
        seniorRan = true;
        return { senior: 'claude', verdict: 'approve', feedback: 'x', raw: 'VERDICT: APPROVE' };
      }
    });

    const res = await runPlanReviewCycle(db, { taskId: 'task-pc', junior: 'B' });
    expect(res.outcome).toBe('revise');
    expect((res as any).by).toBe('rubric');
    expect(seniorRan).toBe(false); // zero senior tokens spent

    const review = db.get<any>('SELECT * FROM bureau_plan_reviews WHERE plan_id = ?', (res as any).planId);
    expect(review.verdict).toBe('amend');
    expect(review.provider).toBe('deterministic');
    expect(review.model).toBe('rubric');
    expect(review.feedback).toMatch(/missing/i);
    // The loop continues with the rubric feedback.
    const next = db.get<any>(`SELECT * FROM bureau_jobs WHERE kind = 'plan.cycle' AND state = 'pending'`);
    expect(JSON.parse(next.payload).priorFeedback).toMatch(/missing/i);
  });

  it('AMEND at the ceiling: the task is blocked, the operator notified, and NO next round is enqueued', async () => {
    const db = createFakeDb();
    seedTask(db, { plan_rounds: 2 }); // one round left (ceiling 3)
    setAntigravityDriverOverride({
      runCommand: async () => ({ transcript: 'reply', plan: GOOD_PLAN, junior: 'A', launched: false })
    });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'revise', feedback: 'still wrong', raw: 'VERDICT: REVISE' })
    });

    const res = await runPlanReviewCycle(db, { taskId: 'task-pc', seniorId: 'claude' });
    expect(res.outcome).toBe('revise');
    expect((res as any).roundsUsed).toBe(3);
    expect((res as any).nextRoundEnqueued).toBe(false);
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', 'task-pc').state).toBe('blocked');
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_jobs WHERE kind = 'plan.cycle'`).n).toBe(0);
  });

  it('is wired as a real job kind: plan.cycle registered, single attempt, long timeout; junior.dispatch timeout fits GUI agents', () => {
    expect(getRegisteredJobKinds()).toContain('plan.cycle');
    const planCycle = getJobDefinition('plan.cycle')!;
    expect(planCycle.options.maxAttempts).toBe(1);
    expect(planCycle.options.timeoutMs).toBeGreaterThanOrEqual(45 * 60 * 1000);
    // The old 120s ceiling predates the (uncapped) adaptive wait; it must not regress.
    const dispatch = getJobDefinition('junior.dispatch')!;
    expect(dispatch.options.timeoutMs).toBeGreaterThan(120000);
  });
});
