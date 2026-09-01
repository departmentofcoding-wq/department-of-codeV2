import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { assignJunior } from '../../engine/harness/antigravity.ts';
import { runPlanReviewCycle } from '../../engine/flow/plan_review_cycle.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { handleVerifyOutcome } from '../../engine/verify/loop.ts';
import type { AttributionTuple, BureauTaskRow } from '../../engine/contract/index.ts';
import type { VerifyRunResult } from '../../engine/verify/verifier.ts';

/**
 * N3: the first 2-concurrent run dispatched BOTH tasks to junior A — the
 * auto-kickoff chain never called the assignment policy, and the cycles'
 * `(opts.junior || 'A')` fallback was the de-facto policy. Both tasks then
 * shared one window/chat and cross-contaminated each other. These tests lock in
 * that every flow door (plan cycle, work-cycle fix dispatch, stale-approval
 * re-review) resolves an unpinned junior through `assignJunior` —
 * deterministic by task id, so the two tasks below (the run's own ids) split
 * across A/B exactly as the policy predicted.
 */

// The two tasks of the contaminated 2026-08-30 run (ids from docs/junior-artifacts/).
const TASK_A = '3756ec6e-4ee5-4110-aa6a-b64d3831c464'; // hashes to junior A
const TASK_B = 'b55e2fda-5309-42c9-a356-2a7971c98543'; // hashes to junior B

/** A passing-plan shape: branch, scope, tests+mutation, walkthrough — satisfies the rubric. */
const GOOD_PLAN = [
  'Implementation Plan',
  'Branch: wt/junior-b-clicker',
  'Scope: index.html only (one button, counter span).',
  'Tests: t_clicker.test.ts asserts count rises; mutation: break the handler → test fails.',
  'Walkthrough: verify build + suite, then post results.'
].join('\n');

const WALKTHROUGH = [
  'Walkthrough',
  'Changed index.html: added a button and a counter span.',
  'Tests: t_clicker.test.ts (2) — count rises on click.',
  'Verification: npm test green; build clean.'
].join('\n');

function seedTask(db: any, taskId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, work_uuid, plan_rounds, cycles, created_at, updated_at)
     VALUES (?, 'Build a clicker', 'one button increments a number', 'single HTML page', 'clicking raises the count', 'node -e "0"', ?, 'work-x', ?, ?, ?, ?)`,
    taskId,
    overrides['state'] ?? 'claimed',
    overrides['plan_rounds'] ?? 0,
    overrides['cycles'] ?? 0,
    now,
    now
  );
}

function setCeiling(db: any, key: string, n: number) {
  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    String(n)
  );
}

describe('N3: junior assignment — unpinned juniors resolve via the policy, never a hardcoded A', () => {
  let savedJuniorDefault: string | undefined;

  beforeEach(() => {
    // The policy honors JUNIOR_DEFAULT; the deterministic split must be what runs.
    savedJuniorDefault = process.env.JUNIOR_DEFAULT;
    delete process.env.JUNIOR_DEFAULT;
  });
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
    if (savedJuniorDefault === undefined) delete process.env.JUNIOR_DEFAULT;
    else process.env.JUNIOR_DEFAULT = savedJuniorDefault;
  });

  it('the fixture ids split across juniors (guards the test fixture itself)', () => {
    expect(assignJunior({ taskId: TASK_A })).toBe('A');
    expect(assignJunior({ taskId: TASK_B })).toBe('B');
  });

  it('plan cycle with no pinned junior drives the ASSIGNED junior and threads it into the implementation dispatch', async () => {
    const db = createFakeDb();
    seedTask(db, TASK_B);

    let driverJunior: string | undefined;
    setAntigravityDriverOverride({
      runCommand: async (_prompt: string, runOpts: any) => {
        driverJunior = runOpts?.junior;
        return { transcript: 'reply', plan: GOOD_PLAN, junior: runOpts?.junior, launched: false };
      }
    });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'opus' })
    });

    // Exactly how auto-kickoff runs it: fileTask enqueues plan.cycle with { taskId } only.
    const res = await runPlanReviewCycle(db, { taskId: TASK_B });
    expect(res.outcome).toBe('approved');
    expect(driverJunior).toBe('B'); // not the hardcoded 'A'
    // The chosen junior propagates into the implementation dispatch (payload.junior).
    const dispatchJob = db.get<any>(`SELECT payload FROM bureau_jobs WHERE kind = 'junior.dispatch'`);
    expect(JSON.parse(dispatchJob.payload).junior).toBe('B');
  });

  it('work-cycle fix dispatch with no pinned junior goes to the ASSIGNED junior', async () => {
    const db = createFakeDb();
    setCeiling(db, 'review:work_rounds_ceiling', 5);
    seedTask(db, TASK_B);
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'revise', feedback: 'add the empty-state test', raw: 'VERDICT: REVISE', model: 'opus' })
    });

    const res = await runWorkReviewCycle(db, { taskId: TASK_B, walkthrough: WALKTHROUGH });
    expect(res.outcome).toBe('revise');

    const fixJob = db.get<any>(`SELECT payload FROM bureau_jobs WHERE kind = 'junior.dispatch'`);
    expect(fixJob).toBeTruthy();
    expect(JSON.parse(fixJob.payload).junior).toBe('B');
  });

  it('stale-approval re-review (verify success path) enqueues work.cycle pinned to the ASSIGNED junior', () => {
    const db = createFakeDb();
    seedTask(db, TASK_B, { state: 'verifying' });
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
       VALUES ('wr-n3', ?, 'work-x', 'walkthrough', 1, 'approved', 'commitC1', 'senior-engineer', 'claude', 'opus', ?)`,
      TASK_B,
      now
    );

    const attr: AttributionTuple = { actor_role: 'verifier', provider: 'deterministic', model: 'core', account: null };
    const PASS = {
      exitCode: 0, signal: null, timedOut: false, durationMs: 5,
      stdoutTail: '', stderrTail: '', stages: [], passBefore: null, passAfter: null
    } as VerifyRunResult;

    const res = handleVerifyOutcome(db, TASK_B, PASS, attr, { tip: 'commitC2' });
    expect(res.isSuccess).toBe(false); // stale approval — re-review, not needs-review
    const job = db.get<any>(`SELECT payload FROM bureau_jobs WHERE kind = 'work.cycle' AND task_id = ?`, TASK_B);
    expect(job).toBeTruthy();
    expect(JSON.parse(job.payload).junior).toBe('B');
    expect(db.get<BureauTaskRow>('SELECT state FROM bureau_tasks WHERE id = ?', TASK_B)!.state).toBe('claimed');
  });

  it('N3 regression — the two concurrent tasks of the 2026-08-30 run drive DIFFERENT juniors', async () => {
    const db = createFakeDb();
    seedTask(db, TASK_A);
    seedTask(db, TASK_B);

    const driven: string[] = [];
    setAntigravityDriverOverride({
      runCommand: async (_prompt: string, runOpts: any) => {
        driven.push(runOpts?.junior);
        return { transcript: 'reply', plan: GOOD_PLAN, junior: runOpts?.junior, launched: false };
      }
    });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'opus' })
    });

    await runPlanReviewCycle(db, { taskId: TASK_A });
    await runPlanReviewCycle(db, { taskId: TASK_B });

    expect(driven).toHaveLength(2);
    expect(new Set(driven)).toEqual(new Set(['A', 'B'])); // no shared window/chat
  });

  it('an explicitly pinned junior still wins over the policy (operator override intact)', async () => {
    const db = createFakeDb();
    seedTask(db, TASK_B); // hashes to B

    let driverJunior: string | undefined;
    setAntigravityDriverOverride({
      runCommand: async (_prompt: string, runOpts: any) => {
        driverJunior = runOpts?.junior;
        return { transcript: 'reply', plan: GOOD_PLAN, junior: runOpts?.junior, launched: false };
      }
    });
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'opus' })
    });

    const res = await runPlanReviewCycle(db, { taskId: TASK_B, junior: 'A' });
    expect(res.outcome).toBe('approved');
    expect(driverJunior).toBe('A');
  });
});
