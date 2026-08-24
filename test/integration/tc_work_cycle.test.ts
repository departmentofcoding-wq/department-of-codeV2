import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { getJobDefinition, getRegisteredJobKinds } from '../../engine/jobs/registry.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';

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

const WALKTHROUGH = [
  'Walkthrough',
  'Changed index.html: added a button and a counter span.',
  'Tests: t_clicker.test.ts (2) — count rises on click.',
  'Verification: npm test green; build clean.'
].join('\n');

describe('Work-review cycle — senior reads the walkthrough after implementation', () => {
  afterEach(() => {
    setSeniorDriverOverride(null);
  });

  it('APPROVED: the senior reviews the walkthrough (with the task verbatim), records a work_review + review span, returns approved', async () => {
    const db = createFakeDb();
    seedTask(db);

    let sawKind = '';
    let sawTask = '';
    let sawWalkthrough = '';
    setSeniorDriverOverride({
      review: async (input: any) => {
        sawKind = input.kind;
        sawTask = input.taskTitle + '|' + (input.taskIntent ?? '') + '|' + (input.taskAcceptance ?? '');
        sawWalkthrough = input.walkthrough;
        return { senior: 'zai', verdict: 'approve', feedback: 'work matches the task', raw: 'VERDICT: APPROVE', model: 'glm-test' };
      }
    });

    const res = await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'zai', walkthrough: WALKTHROUGH });
    expect(res.outcome).toBe('approved');

    // The senior actually READ the walkthrough, against the task verbatim.
    expect(sawKind).toBe('walkthrough');
    expect(sawWalkthrough).toContain('t_clicker.test.ts');
    expect(sawTask).toContain('Build a clicker');
    expect(sawTask).toContain('one button increments a number');

    // A real work_review row with honest attribution.
    const review = db.get<any>('SELECT * FROM bureau_work_reviews WHERE task_id = ?', 'task-wc');
    expect(review.verdict).toBe('approved');
    expect(review.actor_role).toBe('senior-engineer');
    expect(review.provider).toBe('zai');
    expect(review.model).toBe('glm-test');
    expect(review.phase).toBe('walkthrough');

    // An attributed review span was journaled.
    const span = db.get<any>(`SELECT * FROM bureau_journal WHERE kind = 'review' AND detail LIKE '%work-review%'`);
    expect(span).toBeTruthy();
  });

  it('REVISE: an amend verdict is recorded and surfaced; the task is NOT marked done (the done-gate is untouched)', async () => {
    const db = createFakeDb();
    seedTask(db);
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'revise', feedback: 'missing the empty-state test', raw: 'VERDICT: REVISE' })
    });

    const res = await runWorkReviewCycle(db, { taskId: 'task-wc', seniorId: 'claude', walkthrough: WALKTHROUGH });
    expect(res.outcome).toBe('revise');

    const review = db.get<any>('SELECT * FROM bureau_work_reviews WHERE task_id = ?', 'task-wc');
    expect(review.verdict).toBe('amend');
    expect(review.comments).toContain('missing the empty-state test');

    // The done-gate invariant holds: nothing moved the task to done.
    expect(db.get<any>('SELECT state FROM bureau_tasks WHERE id = ?', 'task-wc').state).not.toBe('done');
  });

  it('NO WALKTHROUGH: with nothing captured to review, the cycle skips with a guardrail span rather than billing a senior', async () => {
    const db = createFakeDb();
    seedTask(db);
    let seniorRan = false;
    setSeniorDriverOverride({
      review: async () => {
        seniorRan = true;
        return { senior: 'zai', verdict: 'approve', feedback: 'x', raw: 'VERDICT: APPROVE' };
      }
    });

    // No walkthrough override and no artifacts on disk for this task id.
    const res = await runWorkReviewCycle(db, { taskId: 'task-wc', walkthrough: '   ' });
    expect(res).toEqual({ outcome: 'skipped', reason: 'no_walkthrough' });
    expect(seniorRan).toBe(false);
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_work_reviews`).n).toBe(0);
    expect(
      db.get<any>(`SELECT COUNT(*) n FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%work_review_no_walkthrough%'`).n
    ).toBe(1);
  });

  it('is wired as a real job kind: work.cycle registered, single attempt, long timeout', () => {
    expect(getRegisteredJobKinds()).toContain('work.cycle');
    const def = getJobDefinition('work.cycle')!;
    expect(def.options.maxAttempts).toBe(1);
    expect(def.options.timeoutMs).toBeGreaterThanOrEqual(45 * 60 * 1000);
  });
});
