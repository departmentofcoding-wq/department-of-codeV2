import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { rekickTaskFlow } from '../../engine/flow/rekick.ts';
import { ensureTaskAssignment } from '../../engine/flow/assignment.ts';
import { planCycleJobId } from '../../engine/jobs/ids.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

const HUMAN = {
  actor_role: 'human-operator' as const,
  provider: 'human' as const,
  model: 'operator' as const,
  account: 'operator'
};

let db: DbConnection & { close: () => void };
let dir: string;

function insertTask(id: string, state: string, junior: string | null = null, senior: string | null = null): void {
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, assigned_junior, assigned_senior, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`,
    id,
    `Task ${id}`,
    state,
    `work-${id}`,
    junior,
    senior
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'resume-flow-'));
  db = createRealSqliteDb(path.join(dir, 'bureau.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Integration: Resume flow and N17 concurrency / assignment discipline', () => {
  it('queued task with dead plan.cycle: revived -> retains assignment or acquires pin via queue manager', () => {
    insertTask('task-q1', 'queued');
    const jobId = planCycleJobId('task-q1');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
       VALUES (?, 'plan.cycle', 'task-q1', '{"taskId":"task-q1"}', 'dead', 1, 1, 1, 'Harness window failed', '2026-08-29T00:00:00.000Z')`,
      jobId
    );

    // Operator clicks Resume
    const res = rekickTaskFlow(db, 'task-q1', HUMAN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.action).toBe('plan-cycle-reset');

    // Verify job is pending
    const job = db.get<{ state: string; attempts: number }>('SELECT state, attempts FROM bureau_jobs WHERE id = ?', jobId);
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(0);

    // Ensure task assignment pin
    const assignRes = ensureTaskAssignment(db, 'task-q1');
    expect(assignRes.status).toBe('assigned');

    const task = db.get<{ assigned_junior: string; assigned_senior: string }>(
      'SELECT assigned_junior, assigned_senior FROM bureau_tasks WHERE id = ?',
      'task-q1'
    );
    expect(task?.assigned_junior).toBeTruthy();
    expect(task?.assigned_senior).toBeTruthy();

    // Verify assignment journal span
    const assignSpan = db.get<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM bureau_journal WHERE kind = 'assignment' AND task_id = 'task-q1' ORDER BY id DESC LIMIT 1`
    );
    expect(assignSpan?.kind).toBe('assignment');
  });

  it('claimed task with dead work cycle: revived in-place and preserves junior and senior pins', () => {
    // Task is pinned to junior A and senior claude
    insertTask('task-c1', 'claimed', 'A', 'claude');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
       VALUES ('work-cycle-1', 'work.cycle', 'task-c1', '{"taskId":"task-c1","junior":"A","senior":"claude"}', 'dead', 3, 3, 1, 'CDP connection closed', '2026-08-29T00:00:00.000Z')`
    );

    // Operator clicks Resume
    const res = rekickTaskFlow(db, 'task-c1', HUMAN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.action).toBe('cycle-reset');
    expect(res.jobId).toBe('work-cycle-1');

    // In-place revival: single row, attempts reset, state pending
    const job = db.get<{ state: string; attempts: number; payload: string }>(
      'SELECT state, attempts, payload FROM bureau_jobs WHERE id = ?',
      'work-cycle-1'
    );
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(0);
    expect(job?.payload).toContain('"junior":"A"');

    // Task pins stand untouched (no reassignment churn)
    const task = db.get<{ assigned_junior: string; assigned_senior: string; state: string }>(
      'SELECT assigned_junior, assigned_senior, state FROM bureau_tasks WHERE id = ?',
      'task-c1'
    );
    expect(task?.state).toBe('claimed');
    expect(task?.assigned_junior).toBe('A');
    expect(task?.assigned_senior).toBe('claude');

    // Human attribution span in journal
    const humanSpan = db.get<{ kind: string; actor_role: string }>(
      `SELECT kind, actor_role FROM bureau_journal WHERE kind = 'human' AND task_id = 'task-c1' ORDER BY id DESC LIMIT 1`
    );
    expect(humanSpan?.actor_role).toBe('human-operator');
  });

  it('blocked task with dead work cycle: revived in-place and retains pins', () => {
    insertTask('task-blk-1', 'blocked', 'B', 'zai');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
       VALUES ('work-cycle-blk-1', 'work.cycle', 'task-blk-1', '{"taskId":"task-blk-1","junior":"B","senior":"zai"}', 'dead', 3, 3, 1, 'Review failure', '2026-08-29T00:00:00.000Z')`
    );

    const res = rekickTaskFlow(db, 'task-blk-1', HUMAN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.action).toBe('cycle-reset');
    expect(res.jobId).toBe('work-cycle-blk-1');

    const job = db.get<{ state: string; attempts: number }>('SELECT state, attempts FROM bureau_jobs WHERE id = ?', 'work-cycle-blk-1');
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(0);

    const task = db.get<{ assigned_junior: string; assigned_senior: string; state: string }>(
      'SELECT assigned_junior, assigned_senior, state FROM bureau_tasks WHERE id = ?',
      'task-blk-1'
    );
    expect(task?.assigned_junior).toBe('B');
    expect(task?.assigned_senior).toBe('zai');
  });

  it('N4: does NOT bypass FIFO admission / assignment when junior capacity is full', () => {
    // Occupy junior A and junior B with in-flight claimed tasks
    insertTask('task-active-1', 'claimed', 'A', 'claude');
    insertTask('task-active-2', 'claimed', 'B', 'zai');

    // Task 3 is unassigned queued with dead cycle
    insertTask('task-q3', 'queued');
    const jobId = planCycleJobId('task-q3');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
       VALUES (?, 'plan.cycle', 'task-q3', '{"taskId":"task-q3"}', 'dead', 1, 1, 1, 'Harness stall', '2026-08-29T00:00:00.000Z')`,
      jobId
    );

    // Operator resumes task-q3 -> plan.cycle reset to pending
    const res = rekickTaskFlow(db, 'task-q3', HUMAN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.action).toBe('plan-cycle-reset');

    // Capacity check: attempt to assign under full roster -> returns unavailable (no_free_junior)
    const assignFull = ensureTaskAssignment(db, 'task-q3');
    expect(assignFull.status).toBe('unavailable');

    const taskStillUnassigned = db.get<{ assigned_junior: string | null }>(
      'SELECT assigned_junior FROM bureau_tasks WHERE id = ?',
      'task-q3'
    );
    expect(taskStillUnassigned?.assigned_junior).toBeNull();

    // Free junior A by completing task-active-1 (verifier exit 0 + approved)
    db.run(`UPDATE bureau_tasks SET state = 'done', verifier_exit_code = 0, approved_at = '2026-08-29T01:00:00.000Z', approved_by = 'human-operator' WHERE id = 'task-active-1'`);

    // Now capacity exists -> task-q3 is successfully assigned with pin!
    const assignAfter = ensureTaskAssignment(db, 'task-q3');
    expect(assignAfter.status).toBe('assigned');
    if (assignAfter.status === 'assigned') {
      expect(assignAfter.assignment.junior).toBe('A');
    }
  });
});
