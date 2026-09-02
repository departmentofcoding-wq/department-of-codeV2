import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { HarnessError } from '../../engine/harness/errors.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { runPlanReviewCycle } from '../../engine/flow/plan_review_cycle.ts';
import { rearmTask } from '../../engine/state/machine.ts';
import type { AttributionTuple } from '../../engine/contract/types.ts';

function seedTask(db: any, id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, cycles, plan_rounds, created_at, updated_at)
     VALUES (?, 'Task title', 'Task intent', 'Task spec', 'Task acceptance', ?, 'work-uuid', ?, ?, ?, ?)`,
    id,
    overrides['state'] ?? 'claimed',
    overrides['cycles'] ?? 0,
    overrides['plan_rounds'] ?? 0,
    now,
    now
  );
}

function setStallRetries(db: any, retries: number) {
  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES ('senior:stall_retries', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(retries)
  );
}

const WALKTHROUGH = [
  'Walkthrough',
  'Changed index.html: added a button and a counter span.',
  'Tests: t_clicker.test.ts (2) — count rises on click.',
  'Verification: npm test green; build clean.'
].join('\n');

const GOOD_PLAN = [
  'Implementation Plan',
  'Branch: wt/junior-b-clicker',
  'Scope: index.html only (one button, counter span).',
  'Tests: t_clicker.test.ts asserts count rises; mutation: break the handler → test fails.',
  'Walkthrough: verify build + suite, then post results.'
].join('\n');

const OPERATOR_ATTRIBUTION: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'console',
  account: 'operator@bureau'
};

describe('N15: Senior stall resilience (bounded retries + re-armable failure)', () => {
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
  });

  it('work.cycle transient stall recovery (N-1 stalls then success)', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-wc-retry');
    setStallRetries(db, 2);

    let calls = 0;
    const sawFreshConvs: boolean[] = [];
    setSeniorDriverOverride({
      review: async (input: any) => {
        calls++;
        sawFreshConvs.push(input.freshConversation);
        if (calls === 1) {
          throw new HarnessError('Claude CLI senior stalled: no output for 300s (CLAUDE_SENIOR_STALL_MS)');
        }
        return {
          senior: 'claude',
          verdict: 'approve',
          feedback: 'all acceptance criteria met',
          raw: 'VERDICT: APPROVE\nLooks good.',
          model: 'claude-3-7-sonnet'
        };
      }
    });

    const res = await runWorkReviewCycle(db, {
      taskId: 'task-wc-retry',
      seniorId: 'claude',
      walkthrough: WALKTHROUGH
    });

    expect(res.outcome).toBe('approved');
    expect(calls).toBe(2);
    // Initial attempt honors (cycles == 0) -> fresh: true; retry forced fresh: true.
    expect(sawFreshConvs).toEqual([true, true]);

    // Retry guardrail span was recorded
    const retrySpans = db.all<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%senior_review_retry%'`
    );
    expect(retrySpans.length).toBe(1);
    const retryDetail = JSON.parse(retrySpans[0].detail);
    expect(retryDetail.attempt).toBe(1);
    expect(retryDetail.maxRetries).toBe(2);
    expect(retryDetail.senior).toBe('claude');

    // Exactly 1 review row recorded in DB with correct attribution
    const reviews = db.all<any>('SELECT * FROM bureau_work_reviews WHERE task_id = ?', 'task-wc-retry');
    expect(reviews.length).toBe(1);
    expect(reviews[0].verdict).toBe('approved');
    expect(reviews[0].provider).toBe('claude');
    expect(reviews[0].model).toBe('claude-3-7-sonnet');
    expect(reviews[0].round).toBe(1);

    // Cycles updated to 1
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', 'task-wc-retry');
    expect(task.cycles).toBe(1);
    expect(task.state).toBe('claimed');
  });

  it('plan.cycle transient stall recovery (N-1 stalls then success)', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-pc-retry', { state: 'queued' });
    setStallRetries(db, 2);

    let authoringCalls = 0;
    setAntigravityDriverOverride({
      runCommand: async () => {
        authoringCalls++;
        return { transcript: 'authored plan', plan: GOOD_PLAN, junior: 'B', launched: false, model: 'Gemini 3.7 Flash' };
      }
    });

    let reviewCalls = 0;
    setSeniorDriverOverride({
      review: async () => {
        reviewCalls++;
        if (reviewCalls === 1) {
          throw new HarnessError('Claude CLI senior stalled: no output for 300s (CLAUDE_SENIOR_STALL_MS)');
        }
        return {
          senior: 'claude',
          verdict: 'approve',
          feedback: 'sound plan',
          raw: 'VERDICT: APPROVE\nProceed.',
          model: 'claude-3-7-sonnet'
        };
      }
    });

    const res = await runPlanReviewCycle(db, {
      taskId: 'task-pc-retry',
      seniorId: 'claude',
      junior: 'B'
    });

    expect(res.outcome).toBe('approved');
    // Junior only authored ONCE; retries only happened on senior review
    expect(authoringCalls).toBe(1);
    expect(reviewCalls).toBe(2);

    // Plan row exists
    const plans = db.all<any>('SELECT * FROM bureau_plans WHERE task_id = ?', 'task-pc-retry');
    expect(plans.length).toBe(1);
    expect(plans[0].status).toBe('approved');

    // Review row exists
    const reviews = db.all<any>('SELECT * FROM bureau_plan_reviews WHERE task_id = ?', 'task-pc-retry');
    expect(reviews.length).toBe(1);
    expect(reviews[0].verdict).toBe('approved');

    // Implementation dispatch enqueued
    const dispatches = db.all<any>('SELECT * FROM bureau_dispatches WHERE task_id = ?', 'task-pc-retry');
    expect(dispatches.length).toBe(1);

    // Task transitioned queued -> claimed
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', 'task-pc-retry');
    expect(task.state).toBe('claimed');
    expect(task.plan_rounds).toBe(1);
  });

  it('work.cycle stall exhaustion (state === claimed) transitions to blocked and is rearmable', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-wc-exhaust', { state: 'claimed' });
    setStallRetries(db, 2);

    let calls = 0;
    setSeniorDriverOverride({
      review: async () => {
        calls++;
        throw new HarnessError('Senior subprocess crashed unexpectedly');
      }
    });

    const res = await runWorkReviewCycle(db, {
      taskId: 'task-wc-exhaust',
      seniorId: 'claude',
      walkthrough: WALKTHROUGH
    });

    expect(res.outcome).toBe('blocked');
    expect((res as any).reason).toBe('senior_stall_exhausted');
    expect((res as any).attempts).toBe(3); // 1 initial + 2 retries
    expect(calls).toBe(3);

    // Task transitioned to blocked
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', 'task-wc-exhaust');
    expect(task.state).toBe('blocked');

    // Exhaustion journal span recorded
    const exhaustSpans = db.all<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%senior_stall_exhausted%'`
    );
    expect(exhaustSpans.length).toBe(1);
    const detail = JSON.parse(exhaustSpans[0].detail);
    expect(detail.attempts).toBe(3);
    expect(detail.senior).toBe('claude');

    // No work review row recorded (fail-closed)
    const reviews = db.all<any>('SELECT * FROM bureau_work_reviews WHERE task_id = ?', 'task-wc-exhaust');
    expect(reviews.length).toBe(0);

    // Operator re-arms the task with reenqueueKind: 'work.cycle'
    const rearmedTask = rearmTask(db, 'task-wc-exhaust', OPERATOR_ATTRIBUTION, { reenqueueKind: 'work.cycle' });
    expect(rearmedTask.state).toBe('claimed');

    // Job enqueued in bureau_jobs
    const jobs = db.all<any>(
      `SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'work.cycle' AND state = 'pending'`,
      'task-wc-exhaust'
    );
    expect(jobs.length).toBe(1);
  });

  it('plan.cycle stall exhaustion from queued executes two-hop queued -> claimed -> blocked', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-pc-queued-exhaust', { state: 'queued' });
    setStallRetries(db, 1);

    setAntigravityDriverOverride({
      runCommand: async () => ({ transcript: 'reply', plan: GOOD_PLAN, junior: 'A', launched: false })
    });

    let calls = 0;
    setSeniorDriverOverride({
      review: async () => {
        calls++;
        throw new HarnessError('Claude CLI senior stalled: no output for 300s');
      }
    });

    const res = await runPlanReviewCycle(db, {
      taskId: 'task-pc-queued-exhaust',
      seniorId: 'claude'
    });

    expect(res.outcome).toBe('blocked');
    expect((res as any).reason).toBe('senior_stall_exhausted');
    expect((res as any).attempts).toBe(2); // 1 initial + 1 retry
    expect(calls).toBe(2);

    // Task transitioned through queued -> claimed -> blocked
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', 'task-pc-queued-exhaust');
    expect(task.state).toBe('blocked');

    // Journal transition spans verify the two-hop progression
    const transitions = db.all<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'transition' AND task_id = ? ORDER BY id ASC`,
      'task-pc-queued-exhaust'
    );
    expect(transitions.length).toBe(2);
    const t1 = JSON.parse(transitions[0].detail);
    expect(t1.reason).toBe('senior_stall_exhaustion_claim');
    const t2 = JSON.parse(transitions[1].detail);
    expect(t2.reason).toBe('senior_stall_exhausted');
    expect(t2.attempts).toBe(2);

    // Operator rearmTask successfully recovers the task
    const rearmed = rearmTask(db, 'task-pc-queued-exhaust', OPERATOR_ATTRIBUTION, { reenqueueKind: 'plan.cycle' });
    expect(rearmed.state).toBe('claimed');
    const jobs = db.all<any>(
      `SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'plan.cycle' AND state = 'pending'`,
      'task-pc-queued-exhaust'
    );
    expect(jobs.length).toBe(1);
  });

  it('plan.cycle stall exhaustion from claimed transitions directly claimed -> blocked', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-pc-claimed-exhaust', { state: 'claimed' });
    setStallRetries(db, 1);

    setAntigravityDriverOverride({
      runCommand: async () => ({ transcript: 'reply', plan: GOOD_PLAN, junior: 'A', launched: false })
    });

    setSeniorDriverOverride({
      review: async () => {
        throw new HarnessError('ZCode CDP connection reset');
      }
    });

    const res = await runPlanReviewCycle(db, {
      taskId: 'task-pc-claimed-exhaust',
      seniorId: 'zai'
    });

    expect(res.outcome).toBe('blocked');
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE id = ?', 'task-pc-claimed-exhaust');
    expect(task.state).toBe('blocked');

    const transitions = db.all<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'transition' AND task_id = ?`,
      'task-pc-claimed-exhaust'
    );
    expect(transitions.length).toBe(1);
    const t1 = JSON.parse(transitions[0].detail);
    expect(t1.reason).toBe('senior_stall_exhausted');
    expect(t1.attempts).toBe(2);
  });

  it('re-review continuation with cycles > 0 uses freshConversation=false on initial try, true on retry', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-wc-cont', { cycles: 1, state: 'claimed' });
    setStallRetries(db, 2);

    let calls = 0;
    const sawFreshConvs: boolean[] = [];
    setSeniorDriverOverride({
      review: async (input: any) => {
        calls++;
        sawFreshConvs.push(input.freshConversation);
        if (calls === 1) {
          throw new HarnessError('Transient stall on round 2');
        }
        return {
          senior: 'claude',
          verdict: 'approve',
          feedback: 'amendments verified',
          raw: 'VERDICT: APPROVE',
          model: 'claude-3-7-sonnet'
        };
      }
    });

    const res = await runWorkReviewCycle(db, {
      taskId: 'task-wc-cont',
      seniorId: 'claude',
      walkthrough: WALKTHROUGH
    });

    expect(res.outcome).toBe('approved');
    expect(calls).toBe(2);
    // Initial try reused conversation (false); retry used fresh conversation (true)
    expect(sawFreshConvs).toEqual([false, true]);
  });
});
