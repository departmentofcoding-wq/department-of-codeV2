import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { getJobDefinition, getRegisteredJobKinds } from '../../engine/jobs/registry.ts';
import { runWorkReviewCycle, buildFixPrompt } from '../../engine/flow/work_review_cycle.ts';

function seedTask(db: any, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, cycles, created_at, updated_at)
     VALUES ('task-wc', 'Build a clicker', 'one button increments a number', 'single HTML page', 'clicking raises the count', ?, 'work-wc', ?, ?, ?)`,
    overrides['state'] ?? 'claimed',
    overrides['cycles'] ?? 0,
    now,
    now
  );
}

function setWorkCeiling(db: any, n: number) {
  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES ('review:work_rounds_ceiling', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(n)
  );
}

const WALKTHROUGH = [
  'Walkthrough',
  'Changed index.html: added a button and a counter span.',
  'Tests: t_clicker.test.ts (2) — count rises on click.',
  'Verification: npm test green; build clean.'
].join('\n');

describe('Work-review cycle — senior reviews, junior fixes, loop until approve (bounded)', () => {
  afterEach(() => {
    setSeniorDriverOverride(null);
  });

  it('APPROVED: records a work_review + review span, increments the round, returns approved', async () => {
    const db = createFakeDb();
    seedTask(db);

    let sawKind = '';
    let sawWalkthrough = '';
    let sawFresh: boolean | undefined;
    setSeniorDriverOverride({
      review: async (input: any) => {
        sawKind = input.kind;
        sawWalkthrough = input.walkthrough;
        sawFresh = input.freshConversation;
        return { senior: 'zai', verdict: 'approve', feedback: 'work matches the task', raw: 'VERDICT: APPROVE', model: 'glm-test' };
      }
    });

    const res = await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'zai', walkthrough: WALKTHROUGH });
    expect(res.outcome).toBe('approved');
    expect((res as any).roundsUsed).toBe(1);

    expect(sawKind).toBe('walkthrough');
    expect(sawWalkthrough).toContain('t_clicker.test.ts');
    // First work review starts a fresh senior conversation.
    expect(sawFresh).toBe(true);

    const review = db.get<any>('SELECT * FROM bureau_work_reviews WHERE task_id = ?', 'task-wc');
    expect(review.verdict).toBe('approved');
    expect(review.provider).toBe('zai');
    expect(review.model).toBe('glm-test');
    // The round was recorded on the task.
    expect(db.get<any>('SELECT cycles FROM bureau_tasks WHERE id = ?', 'task-wc').cycles).toBe(1);
    // No fix dispatch on approval.
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_jobs WHERE kind = 'junior.dispatch'`).n).toBe(0);
    // The approve path no longer dead-ends: it hands the task to the done-gate by
    // enqueuing worktree.prepare (which chains verify.run → needs-review).
    expect((res as any).deliveryJobId).toBeTruthy();
    const prep = db.get<any>(`SELECT * FROM bureau_jobs WHERE kind = 'worktree.prepare' AND task_id = 'task-wc'`);
    expect(prep).toBeTruthy();
    expect(JSON.parse(prep.payload).taskId).toBe('task-wc');
  });

  it('APPROVED is idempotent: a re-review does not enqueue a second worktree.prepare while one is in flight', async () => {
    const db = createFakeDb();
    setWorkCeiling(db, 5);
    seedTask(db, { cycles: 1 });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'zai', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'glm-test' })
    });
    // First approval enqueues the prepare job (state 'pending').
    const first = await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'zai', walkthrough: WALKTHROUGH });
    expect((first as any).deliveryJobId).toBeTruthy();
    // A second approval while it is still pending must NOT enqueue another.
    const second = await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'zai', walkthrough: WALKTHROUGH });
    expect((second as any).deliveryJobId).toBeUndefined();
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_jobs WHERE kind = 'worktree.prepare' AND task_id = 'task-wc'`).n).toBe(1);
  });

  it('continuation round reuses the senior conversation (freshConversation false when cycles > 0)', async () => {
    const db = createFakeDb();
    setWorkCeiling(db, 5);
    seedTask(db, { cycles: 1, state: 'claimed' }); // a later round of the same task
    let sawFresh: boolean | undefined;
    setSeniorDriverOverride({
      review: async (input: any) => {
        sawFresh = input.freshConversation;
        return { senior: 'zai', verdict: 'approve', feedback: 'ok now', raw: 'VERDICT: APPROVE', model: 'glm-test' };
      }
    });
    await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'zai', walkthrough: WALKTHROUGH });
    expect(sawFresh).toBe(false);
  });

  it('REVISE under ceiling: loops — the senior fixes are fed back to the junior as a fix dispatch that will re-review', async () => {
    const db = createFakeDb();
    setWorkCeiling(db, 5);
    seedTask(db, { cycles: 0 });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'revise', feedback: 'add the empty-state test', raw: 'VERDICT: REVISE', model: 'opus' })
    });

    const res = await runWorkReviewCycle(db, {
      taskId: 'task-wc',
      seniorId: 'claude',
      junior: 'B',
      juniorModel: 'Gemini 3.7 Flash',
      walkthrough: WALKTHROUGH
    });
    expect(res.outcome).toBe('revise');
    expect((res as any).ceilingReached).toBe(false);
    expect((res as any).fixDispatchJobId).toBeTruthy();

    const review = db.get<any>('SELECT * FROM bureau_work_reviews WHERE task_id = ?', 'task-wc');
    expect(review.verdict).toBe('amend');

    // A fix dispatch was enqueued for the SAME junior, carrying the required
    // changes and chaining a re-review; it re-reviews with the SAME senior.
    const fixJob = db.get<any>(`SELECT * FROM bureau_jobs WHERE kind = 'junior.dispatch'`);
    expect(fixJob).toBeTruthy();
    const payload = JSON.parse(fixJob.payload);
    expect(payload.junior).toBe('B');
    expect(payload.prompt).toContain('add the empty-state test');
    expect(payload.prompt).toContain('Build a clicker');
    expect(payload.chainWorkReview).toBe(true);
    expect(payload.freshConversation).toBe(false);
    expect(payload.workSeniorId).toBe('claude');

    // Round consumed; task not done.
    expect(db.get<any>('SELECT cycles FROM bureau_tasks WHERE id = ?', 'task-wc').cycles).toBe(1);
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', 'task-wc').state).not.toBe('done');
  });

  it('REVISE at the ceiling: stops looping — the task is BLOCKED and surfaced to the operator, no further fix dispatch', async () => {
    const db = createFakeDb();
    setWorkCeiling(db, 5);
    seedTask(db, { cycles: 4, state: 'claimed' }); // this review is round 5 = ceiling
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'revise', feedback: 'still not right', raw: 'VERDICT: REVISE' })
    });

    const res = await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'claude', walkthrough: WALKTHROUGH });
    expect(res.outcome).toBe('revise');
    expect((res as any).ceilingReached).toBe(true);
    expect((res as any).roundsUsed).toBe(5);

    // Blocked for the operator; no runaway fix dispatch.
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', 'task-wc').state).toBe('blocked');
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_jobs WHERE kind = 'junior.dispatch'`).n).toBe(0);
  });

  it('NO WALKTHROUGH: skips with a guardrail span rather than billing a senior', async () => {
    const db = createFakeDb();
    seedTask(db);
    let seniorRan = false;
    setSeniorDriverOverride({
      review: async () => {
        seniorRan = true;
        return { senior: 'zai', verdict: 'approve', feedback: 'x', raw: 'VERDICT: APPROVE' };
      }
    });

    const res = await runWorkReviewCycle(db, { taskId: 'task-wc', walkthrough: '   ' });
    expect(res).toEqual({ outcome: 'skipped', reason: 'no_walkthrough' });
    expect(seniorRan).toBe(false);
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_work_reviews`).n).toBe(0);
    expect(
      db.get<any>(`SELECT COUNT(*) n FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%work_review_no_walkthrough%'`).n
    ).toBe(1);
  });

  it('buildFixPrompt is honest — asks for the required changes and an updated walkthrough for re-review', () => {
    const p = buildFixPrompt({ title: 'T', intent: 'i' } as any, 'fix the null case', 2, 5);
    expect(p).toMatch(/requesting changes/i);
    expect(p).toContain('round 2 of at most 5');
    expect(p).toContain('fix the null case');
    expect(p).toMatch(/updated walkthrough/i);
    // N0: the completion sentinel rides fix dispatches too.
    expect(p).toContain('BUREAU-JUNIOR-COMPLETE');
  });

  // F2: the fix dispatch continues the task's conversation but may land in a
  // fresh one after a junior restart — the prompt opens with the per-task
  // handle and states it is self-contained (see the plan-cycle F2 tests).
  it('F2: buildFixPrompt opens with the task handle and the self-contained continuation preamble', () => {
    const p = buildFixPrompt({ id: 'task-f2-fix', title: 'T', intent: 'i' } as any, 'fix the null case', 2, 5);
    expect(p.startsWith('[bureau-task:task-f2-fix] T\n')).toBe(true);
    expect(p).toMatch(/CONTEXT — READ FIRST/);
    expect(p).toMatch(/may arrive in a NEW conversation/);
    expect(p).toMatch(/do not re-derive or redo prior work/);
  });

  it('is wired as a real job kind: work.cycle registered, single attempt, long timeout', () => {
    expect(getRegisteredJobKinds()).toContain('work.cycle');
    const def = getJobDefinition('work.cycle')!;
    expect(def.options.maxAttempts).toBe(1);
    expect(def.options.timeoutMs).toBeGreaterThanOrEqual(45 * 60 * 1000);
  });
});
