import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import {
  runPlanReviewCycle,
  buildJuniorPlanPrompt
} from '../../engine/flow/plan_review_cycle.ts';

function seedTask(db: any) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, plan_rounds, created_at, updated_at)
     VALUES ('task-pc', 'Build a clicker', 'one button increments a number', 'single HTML page', 'clicking raises the count', 'claimed', 'work-pc', 0, ?, ?)`,
    now,
    now
  );
}

describe('Plan-review cycle — junior authors, senior reviews (with task verbatim)', () => {
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
  });

  it('buildJuniorPlanPrompt asks for a PLAN ONLY and embeds the task verbatim', () => {
    const p = buildJuniorPlanPrompt({
      title: 'Build a clicker',
      intent: 'one button increments',
      spec: 'single HTML page',
      acceptance: 'count rises on click'
    } as any);
    expect(p).toMatch(/plan/i);
    expect(p).toMatch(/Do NOT write any code/i);
    expect(p).toContain('Build a clicker');
    expect(p).toContain('one button increments');
    expect(p).toContain('count rises on click');
  });

  it('runs junior→senior in order, records plan + review rows, returns the verdict', async () => {
    const db = createFakeDb();
    seedTask(db);

    let seniorSawTask = '';
    let seniorSawPlan = '';
    setAntigravityDriverOverride({
      runCommand: async (prompt: string) => {
        // The junior is asked for a plan; it authors one.
        expect(prompt).toMatch(/plan/i);
        return { transcript: 'reply', plan: '1. index.html — one button, counter', junior: 'B', launched: false };
      }
    });
    setSeniorDriverOverride({
      review: async (input: any) => {
        seniorSawTask = input.taskTitle + '|' + (input.taskIntent ?? '') + '|' + (input.taskAcceptance ?? '');
        seniorSawPlan = input.plan;
        return { senior: 'claude', verdict: 'approve', feedback: 'aligned with task', raw: 'VERDICT: APPROVE' };
      }
    });

    const res = await runPlanReviewCycle(db, { taskId: 'task-pc', junior: 'B', seniorId: 'claude' });

    // Senior received the junior's plan AND the task verbatim.
    expect(seniorSawPlan).toContain('index.html');
    expect(seniorSawTask).toContain('Build a clicker');
    expect(seniorSawTask).toContain('one button increments a number');
    expect(seniorSawTask).toContain('clicking raises the count');

    expect(res.verdict).toBe('approve');
    expect(res.junior).toBe('B');
    expect(res.senior).toBe('claude');

    // A plan row (authored by the junior) and a review row (by the senior) exist.
    const plan = db.get<any>('SELECT * FROM bureau_plans WHERE id = ?', res.planId);
    expect(plan.actor_role).toBe('junior-engineer');
    expect(plan.provider).toBe('antigravity');
    expect(plan.status).toBe('approved');
    const review = db.get<any>('SELECT * FROM bureau_plan_reviews WHERE plan_id = ?', res.planId);
    expect(review.verdict).toBe('approved');
    expect(review.actor_role).toBe('senior-engineer');
    expect(review.provider).toBe('claude');

    // plan_rounds incremented on the task.
    const task = db.get<any>('SELECT plan_rounds FROM bureau_tasks WHERE id = ?', 'task-pc');
    expect(task.plan_rounds).toBe(1);
  });

  it('maps a senior REVISE verdict to an amend plan review', async () => {
    const db = createFakeDb();
    seedTask(db);
    setAntigravityDriverOverride({
      runCommand: async () => ({ transcript: '', plan: 'over-engineered plan', junior: 'A', launched: false })
    });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'zai', verdict: 'revise', feedback: 'too much', raw: 'VERDICT: REVISE' })
    });
    const res = await runPlanReviewCycle(db, { taskId: 'task-pc', seniorId: 'zai' });
    expect(res.verdict).toBe('revise');
    const review = db.get<any>('SELECT verdict FROM bureau_plan_reviews WHERE plan_id = ?', res.planId);
    expect(review.verdict).toBe('amend');
  });
});
