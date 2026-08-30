import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { rekickTaskFlow } from '../../engine/flow/rekick.ts';
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

function insertTask(id: string, state: string): void {
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`,
    id,
    `Task ${id}`,
    state,
    `work-${id}`
  );
}

function insertJob(row: {
  id: string;
  kind: string;
  task_id: string;
  state: string;
  payload?: string;
  max_attempts?: number;
}): void {
  db.run(
    `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0, '2026-08-29T00:00:00.000Z')`,
    row.id,
    row.kind,
    row.task_id,
    row.payload ?? '{}',
    row.state,
    row.max_attempts ?? 1
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rekick-'));
  db = createRealSqliteDb(path.join(dir, 'bureau.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rekickTaskFlow — plan cycle (queued task)', () => {
  it('resets a dead plan.cycle job to pending with budgets cleared, keeping the deterministic id', () => {
    insertTask('t1', 'queued');
    const jobId = planCycleJobId('t1');
    insertJob({ id: jobId, kind: 'plan.cycle', task_id: 't1', state: 'dead', max_attempts: 1 });
    db.run(`UPDATE bureau_jobs SET attempts = 1, reaped_count = 1, last_error = 'boom' WHERE id = ?`, jobId);

    const res = rekickTaskFlow(db, 't1', HUMAN);
    expect(res).toEqual({ ok: true, action: 'plan-cycle-reset', jobId });

    const row = db.get<{ state: string; attempts: number; reaped_count: number; last_error: string | null }>(
      'SELECT state, attempts, reaped_count, last_error FROM bureau_jobs WHERE id = ?',
      jobId
    );
    expect(row).toMatchObject({ state: 'pending', attempts: 0, reaped_count: 0, last_error: null });

    // The reset itself is a journaled human act.
    const span = db.get<{ kind: string; actor_role: string; detail: string }>(
      `SELECT kind, actor_role, detail FROM bureau_journal WHERE job_id = ? AND kind = 'human' ORDER BY id DESC LIMIT 1`,
      jobId
    );
    expect(span?.actor_role).toBe('human-operator');
    expect(JSON.parse(span!.detail)).toMatchObject({ action: 'rekick', target: 'plan.cycle', outcome: 'reset' });
  });

  it('enqueues a fresh plan.cycle when the task has no cycle row at all (the reconciler case)', () => {
    insertTask('t2', 'queued');
    const res = rekickTaskFlow(db, 't2', HUMAN);
    expect(res).toEqual({ ok: true, action: 'plan-cycle-enqueued', jobId: planCycleJobId('t2') });
    const row = db.get<{ state: string; kind: string }>('SELECT state, kind FROM bureau_jobs WHERE id = ?', planCycleJobId('t2'));
    expect(row).toMatchObject({ state: 'pending', kind: 'plan.cycle' });
  });

  it('REFUSES to touch a live (pending) plan.cycle — the double-prompt guard', () => {
    insertTask('t3', 'queued');
    insertJob({ id: planCycleJobId('t3'), kind: 'plan.cycle', task_id: 't3', state: 'pending' });

    const res = rekickTaskFlow(db, 't3', HUMAN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('not dead');
    const row = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', planCycleJobId('t3'));
    expect(row?.state).toBe('pending');
  });

  it('REFUSES when the task state is wrong (needs-review has nothing to re-kick)', () => {
    insertTask('t4', 'needs-review');
    const res = rekickTaskFlow(db, 't4', HUMAN);
    expect(res.ok).toBe(false);
  });

  it('REFUSES an unknown task id', () => {
    const res = rekickTaskFlow(db, 'nope', HUMAN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('not found');
  });
});

describe('rekickTaskFlow — junior dispatch (claimed task)', () => {
  it('re-enqueues the dead dispatch payload verbatim under a new id, leaving the dead row untouched', () => {
    insertTask('t5', 'claimed');
    insertJob({
      id: 'dispatch-1',
      kind: 'junior.dispatch',
      task_id: 't5',
      state: 'dead',
      payload: '{"taskId":"t5","junior":"A","folder":"D:\\\\projects\\\\trading"}',
      max_attempts: 3
    });

    const res = rekickTaskFlow(db, 't5', HUMAN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');

    const reenqueued = db.get<{ payload: string; kind: string; state: string; max_attempts: number }>(
      'SELECT payload, kind, state, max_attempts FROM bureau_jobs WHERE id = ?',
      res.jobId
    );
    expect(reenqueued?.kind).toBe('junior.dispatch');
    expect(reenqueued?.state).toBe('pending');
    expect(reenqueued?.payload).toBe('{"taskId":"t5","junior":"A","folder":"D:\\\\projects\\\\trading"}');
    expect(reenqueued?.max_attempts).toBe(3);

    const dead = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', 'dispatch-1');
    expect(dead?.state).toBe('dead');
  });

  it('REFUSES when the latest dispatch is still running — never double-prompt a GUI agent', () => {
    insertTask('t6', 'claimed');
    insertJob({ id: 'dispatch-2', kind: 'junior.dispatch', task_id: 't6', state: 'running' });

    const res = rekickTaskFlow(db, 't6', HUMAN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('not dead');
    const count = db.get<{ n: number }>(`SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = 't6'`)?.n;
    expect(count).toBe(1);
  });

  it('REFUSES a claimed task with no dispatch job', () => {
    insertTask('t7', 'claimed');
    const res = rekickTaskFlow(db, 't7', HUMAN);
    expect(res.ok).toBe(false);
  });
});

describe('rekickTaskFlow — idempotence under the dead-state predicate', () => {
  it('a second rekick after a successful reset refuses (job is now pending)', () => {
    insertTask('t8', 'queued');
    insertJob({ id: planCycleJobId('t8'), kind: 'plan.cycle', task_id: 't8', state: 'dead' });

    expect(rekickTaskFlow(db, 't8', HUMAN).ok).toBe(true);
    const second = rekickTaskFlow(db, 't8', HUMAN);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('not dead');
  });

  it('the reset is fail-closed against a concurrent state change (dead predicate in SQL)', () => {
    insertTask('t9', 'queued');
    const jobId = planCycleJobId('t9');
    insertJob({ id: jobId, kind: 'plan.cycle', task_id: 't9', state: 'dead' });

    // Simulate another actor reviving it between our read and our write.
    db.run(`UPDATE bureau_jobs SET state = 'pending' WHERE id = ?`, jobId);
    const res = rekickTaskFlow(db, 't9', HUMAN);
    // The pre-read sees pending → refused before SQL even runs.
    expect(res.ok).toBe(false);
    const row = db.get<{ attempts: number }>('SELECT attempts FROM bureau_jobs WHERE id = ?', jobId);
    expect(row?.attempts).toBe(0);
  });
});
