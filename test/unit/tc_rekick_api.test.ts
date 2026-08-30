import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type RekickTaskResult, type ApiErrorResponse } from '../../console/contract.ts';
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

function insertTask(db: DbConnection, id: string, state: string): void {
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')`,
    id,
    `Task ${id}`,
    state,
    `work-${id}`
  );
}

function insertDeadCycle(db: DbConnection, taskId: string): void {
  db.run(
    `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, last_error, created_at)
     VALUES (?, 'plan.cycle', ?, '{"taskId":"' || ? || '"}', 'dead', 1, 1, 1, 'Antigravity IDE workbench window did not become available in time.', '2026-08-29T00:00:00.000Z')`,
    planCycleJobId(taskId),
    taskId,
    taskId
  );
}

describe('POST /api/tasks/:id/rekick (operator recovery door)', () => {
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

  it('revives a dead plan.cycle: 200, job reset to pending, human journal span', async () => {
    insertTask(db, 'task-dead-cycle', 'queued');
    insertDeadCycle(db, 'task-dead-cycle');

    const res = await api<RekickTaskResult>(port, token, 'POST', '/api/tasks/task-dead-cycle/rekick', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('plan-cycle-reset');
    expect(res.body.job_id).toBe(planCycleJobId('task-dead-cycle'));

    const row = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', planCycleJobId('task-dead-cycle'));
    expect(row?.state).toBe('pending');

    const span = db.get<{ kind: string; actor_role: string }>(
      `SELECT kind, actor_role FROM bureau_journal WHERE kind = 'human' AND detail LIKE '%rekick%' ORDER BY id DESC LIMIT 1`
    );
    expect(span?.actor_role).toBe('human-operator');
  });

  it('refuses (400 + guardrail span) when the cycle job is live', async () => {
    insertTask(db, 'task-live-cycle', 'queued');
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, created_at)
       VALUES (?, 'plan.cycle', 'task-live-cycle', '{}', 'pending', 0, 1, 0, '2026-08-29T00:00:00.000Z')`,
      planCycleJobId('task-live-cycle')
    );

    const res = await api<ApiErrorResponse>(port, token, 'POST', '/api/tasks/task-live-cycle/rekick', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('REKICK_REFUSED');

    const span = db.get<{ kind: string }>(
      `SELECT kind FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%rekick_refused%' ORDER BY id DESC LIMIT 1`
    );
    expect(span).toBeTruthy();
  });

  it('refuses an unknown task id with 400 (no crash, no task row invented)', async () => {
    const res = await api<ApiErrorResponse>(port, token, 'POST', '/api/tasks/does-not-exist/rekick', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('REKICK_REFUSED');
  });

  it('requires the token (401 without)', async () => {
    const res = await api<ApiErrorResponse>(port, null, 'POST', '/api/tasks/whatever/rekick', {});
    expect(res.statusCode).toBe(401);
  });
});
