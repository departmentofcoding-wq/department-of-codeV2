import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setAntigravityDriverOverride, type AntigravityDriver } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { reconcileQueuedTasks } from '../../engine/flow/reconcile.ts';
import {
  ensureTaskAssignment,
  juniorIsOccupied,
  readTaskAssignment
} from '../../engine/flow/assignment.ts';
import { runPlanReviewCycle } from '../../engine/flow/plan_review_cycle.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { acquireLease, waitForWindowLease } from '../../engine/harness/lease-manager.ts';
import type { AttributionTuple, DbConnection } from '../../engine/contract/index.ts';

/**
 * N17: claim-time assignment + capacity queue — the 2026-09-02 incident.
 * Three tasks filed within 42 seconds were ALL claimed at once (filing kicked
 * off plan.cycle immediately, no admission control), collided on the two
 * junior windows, time-sliced conversations, and an unpinned dispatch silently
 * opened a fresh junior-A session carrying junior B's approved plan.
 *
 * These tests lock in the new law:
 *   - a task's junior + senior are decided ONCE at claim (queue admission),
 *     persisted on the task row, and read by every phase;
 *   - at most one task per junior is in flight (roster size = capacity);
 *   - filed tasks wait in a FIFO queue — the queue manager admits the next
 *     one only when a junior frees;
 *   - a dispatch without a pin REFUSES instead of defaulting to junior A.
 */

const ATTR: AttributionTuple = {
  actor_role: 'junior-engineer',
  provider: 'antigravity',
  model: 'unspecified',
  account: null
};

/** A passing-plan shape that satisfies the deterministic rubric. */
const GOOD_PLAN = [
  'Implementation Plan',
  'Branch: wt/x',
  'Scope: one file.',
  'Tests: t.test.ts; mutation: break it → test fails.',
  'Walkthrough: verify build + suite, then post results.'
].join('\n');

const now = () => new Date().toISOString();

/** Seed a task row directly (bypassing intake), with the N17 columns. */
function seedTask(
  db: DbConnection,
  id: string,
  o: {
    state?: string;
    createdAt?: string;
    assignedJunior?: string | null;
    assignedSenior?: string | null;
    archived?: boolean;
    planRounds?: number;
  } = {}
) {
  const t = o.createdAt ?? now();
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, work_uuid, plan_rounds, created_at, updated_at,
       assigned_junior, assigned_senior, assigned_at, archived_at)
     VALUES (?, ?, ?, 'work-x', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `Task ${id}`,
    o.state ?? 'queued',
    o.planRounds ?? 0,
    t,
    t,
    o.assignedJunior ?? null,
    o.assignedSenior ?? null,
    o.assignedJunior ? t : null,
    o.archived ? t : null
  );
}

describe('N17: claim-time assignment + capacity queue', () => {
  let savedJuniorDefault: string | undefined;

  beforeEach(() => {
    savedJuniorDefault = process.env.JUNIOR_DEFAULT;
    delete process.env.JUNIOR_DEFAULT;
  });
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
    if (savedJuniorDefault === undefined) delete process.env.JUNIOR_DEFAULT;
    else process.env.JUNIOR_DEFAULT = savedJuniorDefault;
  });

  it('T-N17-1: five filed tasks → one sweep admits exactly the roster size (2), FIFO by created_at, each pinned with a pending plan.cycle', () => {
    const db = createFakeDb();
    const base = Date.now() - 60_000;
    for (let i = 1; i <= 5; i++) {
      seedTask(db, `t${i}`, { createdAt: new Date(base + i * 1000).toISOString() });
    }

    const admitted = reconcileQueuedTasks(db);
    expect(admitted).toEqual(['t1', 't2']);

    // Both admitted tasks are pinned (junior + senior + timestamp) and hold a
    // pending deterministic plan.cycle.
    const juniors = new Set<string>();
    for (const id of ['t1', 't2']) {
      const row = db.get<any>(
        'SELECT assigned_junior, assigned_senior, assigned_at FROM bureau_tasks WHERE id = ?',
        id
      );
      expect(row.assigned_junior).toMatch(/^[AB]$/);
      expect(row.assigned_senior).toBeTruthy();
      expect(row.assigned_at).toBeTruthy();
      juniors.add(row.assigned_junior);
      const job = db.get<any>('SELECT state FROM bureau_jobs WHERE id = ?', `plan.cycle:${id}`);
      expect(job?.state).toBe('pending');
    }
    // The two in-flight tasks hold DIFFERENT juniors — one task per junior.
    expect(juniors.size).toBe(2);

    // The queue behind them is untouched: unassigned, no cycle rows, no spans burned.
    for (const id of ['t3', 't4', 't5']) {
      const row = db.get<any>(
        'SELECT assigned_junior FROM bureau_tasks WHERE id = ?',
        id
      );
      expect(row.assigned_junior).toBeNull();
      expect(
        db.get<any>('SELECT id FROM bureau_jobs WHERE id = ?', `plan.cycle:${id}`)
      ).toBeUndefined();
    }

    // The claim act is on the journal record.
    const spans = db.all<any>(`SELECT * FROM bureau_journal WHERE kind = 'assignment'`);
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      const d = JSON.parse(s.detail);
      expect(d.action).toBe('task_assigned');
      expect(d.junior).toMatch(/^[AB]$/);
      expect(d.senior).toBeTruthy();
    }
  });

  it('T-N17-2: FIFO continues — when the first in-flight task reaches needs-review, the next queued task is admitted onto the freed junior', () => {
    const db = createFakeDb();
    const base = Date.now() - 60_000;
    for (let i = 1; i <= 3; i++) {
      seedTask(db, `t${i}`, { createdAt: new Date(base + i * 1000).toISOString() });
    }
    expect(reconcileQueuedTasks(db)).toEqual(['t1', 't2']);

    const t1Junior = db.get<any>(
      'SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 't1'
    ).assigned_junior;

    // The junior is done being needed: t1 lands at needs-review (human gate).
    db.run(`UPDATE bureau_tasks SET state = 'needs-review' WHERE id = 't1'`);
    expect(juniorIsOccupied(db, t1Junior)).toBe(false);

    const admitted = reconcileQueuedTasks(db);
    expect(admitted).toEqual(['t3']);
    const t3 = db.get<any>(
      'SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 't3'
    );
    // The freed junior is reused — t2 keeps the other one.
    expect(t3.assigned_junior).toBe(t1Junior);
    expect(
      db.get<any>('SELECT state FROM bureau_jobs WHERE id = ?', 'plan.cycle:t3')?.state
    ).toBe('pending');
  });

  it('T-N17-3: blocked and archived tasks free their junior too (the queue never starves behind a parked task)', () => {
    const db = createFakeDb();
    seedTask(db, 't1', { assignedJunior: 'A', assignedSenior: 'claude', state: 'claimed' });
    seedTask(db, 't2', { assignedJunior: 'B', assignedSenior: 'claude', state: 'claimed' });
    seedTask(db, 't3');

    // Roster fully busy → nothing admitted, nothing assigned, no agent work.
    expect(reconcileQueuedTasks(db)).toEqual([]);
    expect(
      db.get<any>('SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 't3').assigned_junior
    ).toBeNull();

    // Operator blocks t1 (senior stall exhaustion etc.) → A frees.
    db.run(`UPDATE bureau_tasks SET state = 'blocked' WHERE id = 't1'`);
    expect(reconcileQueuedTasks(db)).toEqual(['t3']);
    expect(
      db.get<any>('SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 't3').assigned_junior
    ).toBe('A');

    // Archiving works the same way for a claimed task.
    seedTask(db, 't4');
    expect(reconcileQueuedTasks(db)).toEqual([]);
    db.run(`UPDATE bureau_tasks SET archived_at = ? WHERE id = 't2'`, now());
    expect(reconcileQueuedTasks(db)).toEqual(['t4']);
    expect(
      db.get<any>('SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 't4').assigned_junior
    ).toBe('B');
  });

  it('T-N17-4: a plan cycle with no free junior DEFERS — zero agent work, guardrail span, task stays queued/unassigned', async () => {
    const db = createFakeDb();
    seedTask(db, 'busy-1', { assignedJunior: 'A', assignedSenior: 'claude', state: 'claimed' });
    seedTask(db, 'busy-2', { assignedJunior: 'B', assignedSenior: 'claude', state: 'claimed' });
    seedTask(db, 'waiting');

    let agentCalled = false;
    setAntigravityDriverOverride({
      async runCommand() {
        agentCalled = true;
        return { transcript: 'should not happen', plan: GOOD_PLAN, launched: false };
      }
    } as unknown as AntigravityDriver);

    const res = await runPlanReviewCycle(db, { taskId: 'waiting' });
    expect(res).toEqual({ outcome: 'deferred', reason: 'no_free_junior', busy: ['A', 'B'] });
    expect(agentCalled).toBe(false);
    expect(
      db.get<any>('SELECT assigned_junior, state FROM bureau_tasks WHERE id = ?', 'waiting')
    ).toMatchObject({ assigned_junior: null, state: 'queued' });
    const span = db.get<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%plan_cycle_deferred%'`
    );
    expect(span).toBeTruthy();
  });

  it('T-N17-5: the pin is immutable — a later phase with a conflicting explicit pin still drives the ASSIGNED junior', async () => {
    const db = createFakeDb();
    seedTask(db, 'pinned');
    // Claim-time: pinned to A (explicit operator preference at admission).
    const first = ensureTaskAssignment(db, 'pinned', { preferJunior: 'A' });
    expect(first.status).toBe('assigned');
    expect((first as any).assignment.junior).toBe('A');

    // A conflicting later pin never rewrites the row.
    const second = ensureTaskAssignment(db, 'pinned', { preferJunior: 'B' });
    expect(second.status).toBe('assigned');
    expect((second as any).assignment.junior).toBe('A');
    expect(readTaskAssignment(db, 'pinned')?.junior).toBe('A');

    // And the plan cycle honors the pin over its own opts.junior.
    let driven: string | undefined;
    setAntigravityDriverOverride({
      async runCommand(_p: string, o: any) {
        driven = o?.junior;
        return { transcript: 'reply', plan: GOOD_PLAN, junior: o?.junior, launched: false };
      }
    } as unknown as AntigravityDriver);
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', model: 'opus', raw: 'VERDICT: APPROVE' })
    });

    const res = await runPlanReviewCycle(db, { taskId: 'pinned', junior: 'B' });
    expect(res.outcome).toBe('approved');
    expect(driven).toBe('A');
    // The implementation dispatch payload carries the pin too.
    const job = db.get<any>(`SELECT payload FROM bureau_jobs WHERE kind = 'junior.dispatch'`);
    expect(JSON.parse(job.payload).junior).toBe('A');
    expect(JSON.parse(job.payload).freshConversation).toBe(false); // same conversation
  });

  it('T-N17-6: occupancy per state (fresh db per case)', () => {
    const cases: Array<[string, string | null, boolean]> = [
      // [state, cycle job state or null, expectedOccupied]
      ['queued', 'pending', true],
      ['queued', 'running', true],
      ['queued', 'dead', false],
      ['queued', null, false],
      ['claimed', null, true],
      ['verifying', null, true],
      ['needs-review', null, false],
      ['blocked', null, false],
      ['done', null, false],
      ['failed', null, false]
    ];
    for (const [state, cycleState, expected] of cases) {
      const db = createFakeDb();
      // A done row must satisfy the done-gate CHECK (verifier 0 + approval) —
      // the gate stays absolute even in fixtures — so done is INSERTed as
      // claimed then UPDATEd with its approval columns in one statement.
      seedTask(db, 't', {
        state: state === 'done' ? 'claimed' : state,
        assignedJunior: 'A',
        assignedSenior: 'claude'
      });
      if (state === 'done') {
        db.run(
          `UPDATE bureau_tasks SET state = 'done', verifier_exit_code = 0, approved_at = ?, approved_by = 'operator' WHERE id = 't'`,
          now()
        );
      }
      if (cycleState) {
        db.run(
          `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at) VALUES ('c1', 'plan.cycle', 't', ?, ?)`,
          cycleState,
          now()
        );
      }
      expect(juniorIsOccupied(db, 'A'), `${state}/${cycleState ?? 'no-cycle'}`).toBe(expected);
    }
  });

  it('T-N17-7: dispatch drives the ASSIGNMENT junior even when the payload pins another — guardrail span, assignment wins', async () => {
    const db = createFakeDb();
    const t = now();
    seedTask(db, 'task-pin', {
      state: 'claimed',
      assignedJunior: 'B',
      assignedSenior: 'claude'
    });
    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
       VALUES ('disp-pin', 'task-pin', 'work-x', 'junior-engineer', 'antigravity', 'm', 'pending', 0, ?)`,
      t
    );
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at) VALUES ('job-pin', 'junior.dispatch', 'task-pin', 'running', ?)`,
      t
    );

    let driven: string | undefined;
    setAntigravityDriverOverride({
      async runCommand(_p: string, o: any) {
        driven = o?.junior;
        return { transcript: 'ok' };
      }
    } as unknown as AntigravityDriver);

    await handleJuniorDispatch({
      db,
      job: { id: 'job-pin', task_id: 'task-pin' },
      payload: { dispatchId: 'disp-pin', prompt: 'implement', junior: 'A' },
      signal: new AbortController().signal
    } as any);

    expect(driven).toBe('B');
    const span = db.get<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%assignment_pin_mismatch%'`
    );
    expect(span).toBeTruthy();
    expect(JSON.parse(span.detail).assignedJunior).toBe('B');
    // The window targeted the pinned junior's window — never window-default.
    const runSpan = db.get<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'dispatch' AND detail LIKE '%running%'`
    );
    expect(JSON.parse(runSpan.detail).windowTarget).toBe('window-B');
  });

  it('T-N17-8: an unpinned dispatch REFUSES loud — no junior-A default, no window-default lease, guardrail span', async () => {
    const db = createFakeDb();
    const t = now();
    seedTask(db, 'task-bare', { state: 'claimed' }); // no assignment (legacy/pre-N17 shape)
    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
       VALUES ('disp-bare', 'task-bare', 'work-x', 'junior-engineer', 'antigravity', 'm', 'pending', 0, ?)`,
      t
    );
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at) VALUES ('job-bare', 'junior.dispatch', 'task-bare', 'running', ?)`,
      t
    );

    let agentCalled = false;
    setAntigravityDriverOverride({
      async runCommand() {
        agentCalled = true;
        return { transcript: 'must not run' };
      }
    } as unknown as AntigravityDriver);

    await expect(
      handleJuniorDispatch({
        db,
        job: { id: 'job-bare', task_id: 'task-bare' },
        payload: { dispatchId: 'disp-bare', prompt: 'implement' },
        signal: new AbortController().signal
      } as any)
    ).rejects.toThrow(/no junior pin/i);

    expect(agentCalled).toBe(false);
    // No lease was ever taken (window-default would have been the old behavior).
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_window_leases`).n).toBe(0);
    const span = db.get<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%dispatch_unpinned_refused%'`
    );
    expect(span).toBeTruthy();
  });

  it('T-N17-9: a capacity-deferred cycle row (done, round 0) is reset by the next sweep; a DEAD cycle row is left to the operator', () => {
    const db = createFakeDb();
    const t = now();

    // Deferred signature: task queued, unassigned, round 0, cycle row done.
    seedTask(db, 'deferred');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, attempts, created_at, finished_at)
       VALUES ('plan.cycle:deferred', 'plan.cycle', 'deferred', 'done', 1, ?, ?)`,
      t,
      t
    );
    expect(reconcileQueuedTasks(db)).toEqual(['deferred']);
    expect(
      db.get<any>('SELECT state FROM bureau_jobs WHERE id = ?', 'plan.cycle:deferred')?.state
    ).toBe('pending');
    expect(
      db.get<any>('SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 'deferred')
        .assigned_junior
    ).toBeTruthy();

    // Genuinely failed cycle: operator action — NOT requeued, NOT assigned.
    seedTask(db, 'failed-cycle');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, attempts, created_at, finished_at)
       VALUES ('plan.cycle:failed-cycle', 'plan.cycle', 'failed-cycle', 'dead', 1, ?, ?)`,
      t,
      t
    );
    expect(reconcileQueuedTasks(db)).toEqual([]);
    expect(
      db.get<any>('SELECT state FROM bureau_jobs WHERE id = ?', 'plan.cycle:failed-cycle')?.state
    ).toBe('dead');
    expect(
      db.get<any>('SELECT assigned_junior FROM bureau_tasks WHERE id = ?', 'failed-cycle')
        .assigned_junior
    ).toBeNull();
  });

  it('T-N17-10: a window-lease WAIT journals the conflict exactly once — no per-poll span flood', async () => {
    const db = createFakeDb();
    // Another holder owns window-A.
    acquireLease(db, 'window-A', 'holder-other', ATTR);

    await expect(
      waitForWindowLease(db, 'window-A', 'holder-me', ATTR, { waitMs: 500, pollMs: 100 })
    ).rejects.toThrow(/Timed out .*waiting for window lease/);

    const conflicts = db.all<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%window_lease_conflict%'`
    );
    // The 2026-09-02 incident wrote ~150 of these in 3 minutes at pollMs=250.
    expect(conflicts.length).toBe(1);
  });
});
