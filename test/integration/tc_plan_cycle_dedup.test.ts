import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { runPlanReviewCycle } from '../../engine/flow/plan_review_cycle.ts';
import { implementationDispatchJobId, implementationDispatchRowId, planCycleRoundJobId } from '../../engine/jobs/ids.ts';

/**
 * R2 — plan-cycle enqueue idempotence (the 2026-09-08 duplicate-dispatch fork).
 *
 * Scar: one plan.cycle job emitted two review rounds; each round minted a
 * random-id successor cycle, the lineage forked, both branches reached APPROVE
 * and each enqueued its own implementation dispatch. The second dispatch lost
 * the window-B lease race, died ×3, and its salvage blocked the task while the
 * first dispatch was still running (see the R1 salvage guard).
 *
 * The law here: the successor round and the implementation dispatch enqueue
 * with DETERMINISTIC ids via enqueue-if-absent, so a fork collapses at both
 * doors — exactly one successor per (task, round) and ONE live implementation
 * dispatch per task, no matter how many lineages approve.
 */
describe('R2: plan-cycle enqueue idempotence (fork collapse)', () => {
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
  });

  function seedTask(db: any, taskId: string, state = 'claimed', planRounds = 0) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, plan_rounds, created_at, updated_at)
       VALUES (?, 'R2 dedup', 'a forked lineage must not double-dispatch', 'spec', 'accept', ?, 'w-${taskId}', ?, ?, ?)`,
      taskId, state, planRounds, now, now
    );
  }

  const GOOD_PLAN = [
    'Implementation Plan',
    'Branch: wt/junior-a-dedup',
    'Scope: one file.',
    'Tests: t.test.ts asserts behavior; mutation: break it → test fails.',
    'Walkthrough: verify build + suite, then post results.'
  ].join('\n');

  function fakeJunior() {
    setAntigravityDriverOverride({
      async runCommand() {
        return { transcript: GOOD_PLAN, launched: false };
      }
    } as any);
  }

  it('two FORKED amend rounds enqueue exactly ONE successor cycle (deterministic per-round id)', async () => {
    const db = createFakeDb();
    const taskId = 'task-r2-fork';
    seedTask(db, taskId);

    fakeJunior();
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'amend', feedback: 'tighten scope', raw: 'VERDICT: REVISE', model: 'test' })
    } as any);

    // The fork shape: two concurrent cycle executions for ONE task, both
    // completing a round and both trying to enqueue the next round.
    const [r1, r2] = await Promise.all([
      runPlanReviewCycle(db, { taskId, junior: 'A', seniorId: 'claude' }),
      runPlanReviewCycle(db, { taskId, junior: 'A', seniorId: 'claude' })
    ]);
    expect(r1.outcome).toBe('revise');
    expect(r2.outcome).toBe('revise');

    const successors = db.all(
      `SELECT id, state FROM bureau_jobs WHERE kind = 'plan.cycle' AND task_id = ? AND id LIKE '%:r%'`,
      taskId
    );
    expect(successors).toHaveLength(1);
    // Both forked rounds completed round 1 (each snapshot read plan_rounds=0),
    // so both target round 2 — one row, deterministic id.
    expect(successors[0].id).toBe(planCycleRoundJobId(taskId, 2));
    expect(successors[0].state).toBe('pending');

    // Exactly one enqueue_if_absent span for the collapsed successor.
    const spans = db.all(
      `SELECT detail FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%enqueue_if_absent%' AND detail LIKE '%plan.cycle%'`
    );
    expect(spans.length).toBe(1);
  });

  it('two FORKED approvals dispatch exactly ONE implementation (task-keyed dispatch id, one dispatch row)', async () => {
    const db = createFakeDb();
    const taskId = 'task-r2-approve';
    seedTask(db, taskId);

    fakeJunior();
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'test' })
    } as any);

    const [r1, r2] = await Promise.all([
      runPlanReviewCycle(db, { taskId, junior: 'A', seniorId: 'claude' }),
      runPlanReviewCycle(db, { taskId, junior: 'A', seniorId: 'claude' })
    ]);
    expect(r1.outcome).toBe('approved');
    expect(r2.outcome).toBe('approved');

    const dispatchJobs = db.all(
      `SELECT id, state FROM bureau_jobs WHERE kind = 'junior.dispatch' AND task_id = ?`,
      taskId
    );
    expect(dispatchJobs).toHaveLength(1);
    expect(dispatchJobs[0].id).toBe(implementationDispatchJobId(taskId));

    const dispatchRows = db.all(`SELECT id, status FROM bureau_dispatches WHERE task_id = ?`, taskId);
    expect(dispatchRows).toHaveLength(1);
    expect(dispatchRows[0].id).toBe(implementationDispatchRowId(taskId));
    expect(dispatchRows[0].status).toBe('pending');
  });
});
