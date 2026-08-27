import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import {
  CONSOLE_TOKEN_HEADER,
  ENDPOINTS,
  type FileAgentTaskRequest,
  type FileAgentTaskResult,
  type ApiErrorResponse
} from '../../console/contract.ts';
import { setAgentAutofile } from '../../engine/filing/index.ts';
import type { DbConnection, BureauTaskRow, BureauJournalRow } from '../../engine/contract/types.ts';

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

describe('T-TASKS-FILE: Agent task-filing API (POST /api/tasks/file)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TOKEN = 'test-token-tasks-file-456';

  const request: FileAgentTaskRequest = {
    title: 'Harden ntfy retry policy',
    intent: 'Retries currently fire-and-forget; make them journaled job rows.',
    verifyCmd: 'npx vitest run test/unit/tc_ntfy_client.test.ts'
  };

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    db.close();
  });

  async function server() {
    handle = await createConsoleServer({ port: 0, token: TOKEN, db });
    return handle.port;
  }

  it('1. Auth guard: the endpoint fails closed (401) without a valid token', async () => {
    const port = await server();

    const noToken = await api<ApiErrorResponse>(port, null, 'POST', '/api/tasks/file', request);
    expect(noToken.statusCode).toBe(401);
    expect(noToken.body.code).toBe('UNAUTHORIZED');

    const badToken = await api<ApiErrorResponse>(port, 'wrong-token', 'POST', '/api/tasks/file', request);
    expect(badToken.statusCode).toBe(401);

    // Nothing persisted by an unauthenticated caller.
    const rows = db.all<BureauTaskRow>('SELECT * FROM bureau_tasks');
    expect(rows).toHaveLength(0);
  });

  it('2. Flag OFF (default): typed 403 autofile_disabled, zero tasks, guardrail journaled by the engine', async () => {
    const port = await server();

    const res = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/tasks/file', request);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('autofile_disabled');
    expect(res.body.error).toMatch(/intake:agent_autofile/);

    expect(db.all<BureauTaskRow>('SELECT * FROM bureau_tasks')).toHaveLength(0);
    const guardrail = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%autofile_disabled%'"
    );
    expect(guardrail).toBeDefined();
  });

  it('3. Flag ON: files the task, returns task_id, and journals task-filed with the default (claude) attribution', async () => {
    setAgentAutofile(db, true);
    const port = await server();

    const res = await api<FileAgentTaskResult>(port, TOKEN, 'POST', '/api/tasks/file', request);
    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.task_id).toBeTruthy();
    expect(res.body.state).toBe('queued');
    expect(res.body.title).toBe(request.title);

    const row = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', res.body.task_id);
    expect(row).toBeDefined();
    expect(row?.state).toBe('queued');
    expect(row?.verify_cmd).toBe(request.verifyCmd);

    const span = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'task-filed' AND task_id = ?",
      res.body.task_id
    );
    expect(span).toBeDefined();
    expect(span?.actor_role).toBe('senior-engineer');
    expect(span?.provider).toBe('anthropic');
  });

  it('4. Agent identity: agent:"glm" journals senior-engineer/zai attribution', async () => {
    setAgentAutofile(db, true);
    const port = await server();

    const res = await api<FileAgentTaskResult>(port, TOKEN, 'POST', '/api/tasks/file', {
      ...request,
      agent: 'glm'
    });
    expect(res.statusCode).toBe(201);

    const span = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'task-filed' AND task_id = ?",
      res.body.task_id
    );
    expect(span?.provider).toBe('zai');
    expect(span?.model).toBe('glm-5.2');
    expect(span?.actor_role).toBe('senior-engineer');

    const confirmSpan = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%agent-auto-confirm-verify%'"
    );
    expect(confirmSpan?.provider).toBe('zai');
  });

  it('5. Validation: missing title/intent/verifyCmd returns 400; unknown agent returns 400', async () => {
    setAgentAutofile(db, true);
    const port = await server();

    const noTitle = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/tasks/file', {
      intent: 'x',
      verifyCmd: 'npm test'
    });
    expect(noTitle.statusCode).toBe(400);
    expect(noTitle.body.code).toBe('VALIDATION_ERROR');

    const noVerify = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/tasks/file', {
      title: 'x',
      intent: 'y',
      verifyCmd: '   '
    });
    expect(noVerify.statusCode).toBe(400);

    const badAgent = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/tasks/file', {
      ...request,
      agent: 'intern'
    });
    expect(badAgent.statusCode).toBe(400);
    expect(badAgent.body.code).toBe('VALIDATION_ERROR');
  });

  it('6. Endpoint manifest: POST /api/tasks/file is declared and token-guarded', () => {
    const matches = ENDPOINTS.filter((e) => e.path === '/api/tasks/file');
    expect(matches.length).toBe(1);
    expect(matches[0].method).toBe('POST');
    expect(matches[0].auth).toBe('token');
    expect(matches[0].description).toBeTruthy();
  });
});
