import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import {
  CONSOLE_TOKEN_HEADER,
  ENDPOINTS,
  type TaskSummaryDTO,
  type FlowSnapshotDTO,
  type ArchiveTaskResult,
  type ApiErrorResponse
} from '../../console/contract.ts';
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
  // A 'done' row must satisfy the done-gate CHECK (verifier 0 + human approval).
  const done = state === 'done';
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, approved_at, approved_by, priority, work_uuid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    id, `Task ${id}`, state,
    done ? 0 : null,
    done ? '2026-08-20T00:00:00.000Z' : null,
    done ? 'operator' : null,
    `work-${id}`
  );
}

describe('T-C7: Archive / Unarchive / Flow console endpoints', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TOKEN = 'archive-flow-token-xyz';

  beforeEach(() => { db = createFakeDb(); });
  afterEach(async () => {
    if (handle) { await handle.close(); handle = null; }
    db.close();
  });

  async function server() {
    handle = await createConsoleServer({ port: 0, token: TOKEN, db });
    return handle.port;
  }

  it('1. archive removes a task from the live list and files it under the archived list', async () => {
    const port = await server();
    insertTask(db, 'live-1', 'blocked');
    insertTask(db, 'live-2', 'claimed');

    const archived = await api<ArchiveTaskResult>(port, TOKEN, 'POST', '/api/tasks/live-1/archive', { reason: 'test artifact' });
    expect(archived.statusCode).toBe(200);
    expect(archived.body.archived).toBe(true);
    expect(archived.body.archive_reason).toBe('test artifact');

    const live = await api<TaskSummaryDTO[]>(port, TOKEN, 'GET', '/api/tasks');
    expect(live.body.map(t => t.id)).toEqual(['live-2']);

    const arc = await api<TaskSummaryDTO[]>(port, TOKEN, 'GET', '/api/tasks/archived');
    expect(arc.body.map(t => t.id)).toEqual(['live-1']);
    expect(arc.body[0].archive_reason).toBe('test artifact');
    // State is untouched by archiving.
    expect(arc.body[0].state).toBe('blocked');
  });

  it('2. unarchive restores a task to the live list', async () => {
    const port = await server();
    insertTask(db, 'r-1', 'queued');
    await api(port, TOKEN, 'POST', '/api/tasks/r-1/archive', {});

    const restored = await api<ArchiveTaskResult>(port, TOKEN, 'POST', '/api/tasks/r-1/unarchive');
    expect(restored.statusCode).toBe(200);
    expect(restored.body.archived).toBe(false);

    const live = await api<TaskSummaryDTO[]>(port, TOKEN, 'GET', '/api/tasks');
    expect(live.body.map(t => t.id)).toEqual(['r-1']);
    const arc = await api<TaskSummaryDTO[]>(port, TOKEN, 'GET', '/api/tasks/archived');
    expect(arc.body).toEqual([]);
  });

  it('3. archive of an unknown task is refused with a guardrail span', async () => {
    const port = await server();
    const res = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/tasks/nope/archive', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ARCHIVE_REFUSED');
    const span = db.get<{ kind: string }>(`SELECT kind FROM bureau_journal WHERE detail LIKE '%archive_refused%'`);
    expect(span?.kind).toBe('guardrail');
  });

  it('4. GET /api/flow projects in-flight tasks onto the pipeline and flags stuck ones', async () => {
    const port = await server();
    insertTask(db, 'moving', 'claimed');
    insertTask(db, 'stuck', 'blocked');
    insertTask(db, 'shipped', 'done'); // excluded (terminal)

    const res = await api<FlowSnapshotDTO>(port, TOKEN, 'GET', '/api/flow');
    expect(res.statusCode).toBe(200);
    expect(res.body.stages).toContain('Review');
    const ids = res.body.tasks.map(t => t.task_id).sort();
    expect(ids).toEqual(['moving', 'stuck']);
    const stuck = res.body.tasks.find(t => t.task_id === 'stuck')!;
    expect(stuck.is_stuck).toBe(true);
    expect(stuck.stuck_reason).toMatch(/Blocked/);
  });

  it('5. archive/unarchive/flow endpoints fail-closed without a token', async () => {
    const port = await server();
    insertTask(db, 'guard', 'claimed');
    expect((await api<ApiErrorResponse>(port, null, 'POST', '/api/tasks/guard/archive', {})).statusCode).toBe(401);
    expect((await api<ApiErrorResponse>(port, null, 'GET', '/api/flow')).statusCode).toBe(401);
    expect((await api<ApiErrorResponse>(port, null, 'GET', '/api/tasks/archived')).statusCode).toBe(401);
    // The task was never archived.
    const arc = await api<TaskSummaryDTO[]>(port, TOKEN, 'GET', '/api/tasks/archived');
    expect(arc.body).toEqual([]);
  });

  it('6. Endpoint manifest registers the new routes', () => {
    const paths = ENDPOINTS.map(e => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/tasks/archived');
    expect(paths).toContain('GET /api/flow');
    expect(paths).toContain('POST /api/tasks/:id/archive');
    expect(paths).toContain('POST /api/tasks/:id/unarchive');
  });
});
