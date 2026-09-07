import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type ResumeTaskResult, type ApiErrorResponse } from '../../console/contract.ts';
import { planCycleJobId } from '../../engine/jobs/ids.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

function api<T>(
  port: number,
  token: string | null,
  method: 'GET' | 'POST',
  p: string,
  body?: unknown
): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload))
    };
    if (token !== null) headers[CONSOLE_TOKEN_HEADER] = token;

    const req = http.request(`http://127.0.0.1:${port}${p}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode || 500, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ statusCode: res.statusCode || 500, body: data as unknown as T });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function insertTask(db: DbConnection, id: string, state: string, archivedAt: string | null = null): void {
  const isDone = state === 'done';
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, archived_at, verifier_exit_code, approved_at, approved_by, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`,
    id,
    `Task ${id}`,
    state,
    `work-${id}`,
    archivedAt,
    isDone ? 0 : null,
    isDone ? '2026-08-29T00:00:00.000Z' : null,
    isDone ? 'human-operator' : null
  );
}

function insertDeadCycle(db: DbConnection, taskId: string): void {
  db.run(
    `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
     VALUES (?, 'plan.cycle', ?, '{"taskId":"' || ? || '"}', 'dead', 1, 1, 1, 'workbench window unavailable', '2026-08-29T00:00:00.000Z')`,
    planCycleJobId(taskId),
    taskId,
    taskId
  );
}

describe('POST /api/tasks/:id/resume (one-click Workers tab resume)', () => {
  let db: ReturnType<typeof createFakeDb>;
  let handle: ConsoleServerHandle;
  let port: number;
  let token: string;

  beforeEach(async () => {
    db = createFakeDb();
    handle = await createConsoleServer({ port: 0, token: 'test-token', db });
    port = handle.port;
    token = 'test-token';
  });

  afterEach(async () => {
    await handle.close();
    db.close();
  });

  it('requires token auth (401 without)', async () => {
    const res = await api<ApiErrorResponse>(port, null, 'POST', '/api/tasks/task-1/resume', {});
    expect(res.statusCode).toBe(401);
  });

  it('revives dead plan.cycle for queued task: 200, reset to pending, human-operator journal span', async () => {
    insertTask(db, 'task-dead-plan', 'queued');
    insertDeadCycle(db, 'task-dead-plan');

    const res = await api<ResumeTaskResult>(port, token, 'POST', '/api/tasks/task-dead-plan/resume', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('plan-cycle-reset');
    expect(res.body.job_id).toBe(planCycleJobId('task-dead-plan'));

    const row = db.get<{ state: string; attempts: number }>('SELECT state, attempts FROM bureau_jobs WHERE id = ?', planCycleJobId('task-dead-plan'));
    expect(row?.state).toBe('pending');
    expect(row?.attempts).toBe(0);

    const span = db.get<{ kind: string; actor_role: string; detail: string }>(
      `SELECT kind, actor_role, detail FROM bureau_journal WHERE kind = 'human' AND task_id = 'task-dead-plan' ORDER BY id DESC LIMIT 1`
    );
    expect(span?.kind).toBe('human');
    expect(span?.actor_role).toBe('human-operator');
    const detail = JSON.parse(span!.detail);
    expect(detail.action).toBe('resume');
  });

  it('enqueues missing plan.cycle for queued task with no jobs', async () => {
    insertTask(db, 'task-no-jobs', 'queued');

    const res = await api<ResumeTaskResult>(port, token, 'POST', '/api/tasks/task-no-jobs/resume', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('plan-cycle-enqueued');
    expect(res.body.job_id).toBe(planCycleJobId('task-no-jobs'));

    const row = db.get<{ state: string; kind: string }>('SELECT state, kind FROM bureau_jobs WHERE id = ?', planCycleJobId('task-no-jobs'));
    expect(row?.state).toBe('pending');
    expect(row?.kind).toBe('plan.cycle');
  });

  it('revives dead junior.dispatch in-place for claimed task without minting new UUID', async () => {
    insertTask(db, 'task-claimed-dead', 'claimed');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
       VALUES ('dispatch-fixed-id', 'junior.dispatch', 'task-claimed-dead', '{"taskId":"task-claimed-dead","junior":"A"}', 'dead', 3, 3, 1, 'crashed', '2026-08-29T00:00:00.000Z')`
    );

    const res = await api<ResumeTaskResult>(port, token, 'POST', '/api/tasks/task-claimed-dead/resume', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('dispatch-reset');
    expect(res.body.job_id).toBe('dispatch-fixed-id');

    const count = db.get<{ n: number }>(`SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = 'task-claimed-dead'`)?.n;
    expect(count).toBe(1);

    const job = db.get<{ state: string; attempts: number }>('SELECT state, attempts FROM bureau_jobs WHERE id = ?', 'dispatch-fixed-id');
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(0);
  });

  it('harmless double-click returns 200 with already_running: true and preserves single row', async () => {
    insertTask(db, 'task-dbl', 'queued');
    insertDeadCycle(db, 'task-dbl');

    // First click: revives to pending
    const res1 = await api<ResumeTaskResult>(port, token, 'POST', '/api/tasks/task-dbl/resume', {});
    expect(res1.statusCode).toBe(200);
    expect(res1.body.ok).toBe(true);
    expect(res1.body.already_running).toBeFalsy();

    // Second click: returns 200 already-running
    const res2 = await api<ResumeTaskResult>(port, token, 'POST', '/api/tasks/task-dbl/resume', {});
    expect(res2.statusCode).toBe(200);
    expect(res2.body.ok).toBe(true);
    expect(res2.body.already_running).toBe(true);
    expect(res2.body.action).toBe('already-running');

    const count = db.get<{ n: number }>(`SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = 'task-dbl'`)?.n;
    expect(count).toBe(1);
  });

  it('revives dead phase job in-place for a blocked task without forging state', async () => {
    insertTask(db, 'task-blocked-dead', 'blocked');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
       VALUES ('work-cycle-blocked', 'work.cycle', 'task-blocked-dead', '{"taskId":"task-blocked-dead"}', 'dead', 3, 3, 1, 'Senior timeout', '2026-08-29T00:00:00.000Z')`
    );

    const res = await api<ResumeTaskResult>(port, token, 'POST', '/api/tasks/task-blocked-dead/resume', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('cycle-reset');
    expect(res.body.job_id).toBe('work-cycle-blocked');

    const count = db.get<{ n: number }>(`SELECT COUNT(*) n FROM bureau_jobs WHERE task_id = 'task-blocked-dead'`)?.n;
    expect(count).toBe(1);

    const job = db.get<{ state: string; attempts: number }>('SELECT state, attempts FROM bureau_jobs WHERE id = ?', 'work-cycle-blocked');
    expect(job?.state).toBe('pending');
    expect(job?.attempts).toBe(0);

    // Assert dedicated house span kind 'human' in SPAN_KINDS
    const span = db.get<{ kind: string; actor_role: string; job_id: string; detail: string }>(
      `SELECT kind, actor_role, job_id, detail FROM bureau_journal WHERE kind = 'human' AND task_id = 'task-blocked-dead' ORDER BY id DESC LIMIT 1`
    );
    expect(span?.kind).toBe('human');
    expect(span?.actor_role).toBe('human-operator');
    expect(span?.job_id).toBe('work-cycle-blocked');
    const detail = JSON.parse(span!.detail);
    expect(detail.action).toBe('resume');
  });

  it('refuses blocked tasks with no phase jobs with 400', async () => {
    insertTask(db, 'task-blocked-nojob', 'blocked');

    const res = await api<ApiErrorResponse>(port, token, 'POST', '/api/tasks/task-blocked-nojob/resume', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RESUME_REFUSED');
  });

  it('refuses done tasks with 400 and records a guardrail journal span', async () => {
    insertTask(db, 'task-done', 'done');

    const res = await api<ApiErrorResponse>(port, token, 'POST', '/api/tasks/task-done/resume', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RESUME_REFUSED');

    const span = db.get<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-done' ORDER BY id DESC LIMIT 1`
    );
    expect(span?.kind).toBe('guardrail');
    expect(span?.detail).toContain('done tasks cannot be resumed');
  });

  it('refuses archived tasks with 400 and records a guardrail journal span', async () => {
    insertTask(db, 'task-archived', 'queued', '2026-08-29T10:00:00.000Z');

    const res = await api<ApiErrorResponse>(port, token, 'POST', '/api/tasks/task-archived/resume', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RESUME_REFUSED');

    const span = db.get<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-archived' ORDER BY id DESC LIMIT 1`
    );
    expect(span?.kind).toBe('guardrail');
    expect(span?.detail).toContain('archived tasks cannot be resumed');
  });
});
