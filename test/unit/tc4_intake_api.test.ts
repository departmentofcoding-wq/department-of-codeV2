import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type IntakeStateDTO, type ConfirmFileResult } from '../../console/contract.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { setOfficerClientOverride } from '../../engine/officers/task_intake_officer.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

function api<T>(port: number, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: {
          [CONSOLE_TOKEN_HEADER]: token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 500, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function officerTurn(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, text = 'ok') {
  return {
    text,
    toolCalls,
    tokensIn: 40,
    tokensOut: 12,
    latencyMs: 10,
    costUsd: null,
    finishReason: 'tool_calls' as const,
    truncated: false
  };
}

describe('T-C4: Conversational Intake API (task creation front door)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TOKEN = 'intake-token-abcdef';

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(async () => {
    setOfficerClientOverride(null);
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

  it('drafts the verify command via the officer, then files on human confirm', async () => {
    setOfficerClientOverride(new MockClient([
      officerTurn([
        { id: 'c1', name: 'propose_field', arguments: { field: 'intent', value: 'Export the task list as CSV' } },
        { id: 'c2', name: 'propose_verify', arguments: { command: 'vitest run test/unit/export.test.ts' } },
        { id: 'c3', name: 'ask_human', arguments: { question: 'I will check it by running the export test suite — approve?' } }
      ])
    ]));
    const port = await server();

    const start = await api<IntakeStateDTO>(port, TOKEN, 'POST', '/api/intake', { prompt: 'Add a way to export tasks as CSV' });
    expect(start.statusCode).toBe(200);
    expect(start.body.verify_cmd).toBe('vitest run test/unit/export.test.ts');
    expect(start.body.can_file).toBe(true);
    expect(start.body.awaiting_verify_confirmation).toBe(true);
    expect(start.body.gaps).toContain('verify_confirmed');
    // The operator never typed the verify command; the officer drafted it.
    expect(start.body.latest_question).toContain('approve');

    const sessionId = start.body.session_id;
    const filed = await api<ConfirmFileResult>(port, TOKEN, 'POST', `/api/intake/${sessionId}/confirm-file`, {});
    expect(filed.statusCode).toBe(200);
    expect(filed.body.ok).toBe(true);
    expect(filed.body.state).toBe('queued');

    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE intake_session_id = ?', sessionId);
    expect(task.state).toBe('queued');
    expect(task.verify_cmd).toBe('vitest run test/unit/export.test.ts');

    const filedSpan = db.get<any>("SELECT * FROM bureau_journal WHERE kind = 'task-filed'");
    expect(filedSpan).not.toBeNull();
  });

  it('carries an ask_human round-trip across turns', async () => {
    setOfficerClientOverride(new MockClient([
      // Turn 1: only asks a clarifying question, proposes intent
      officerTurn([
        { id: 'a1', name: 'propose_field', arguments: { field: 'intent', value: 'Export tasks' } },
        { id: 'a2', name: 'ask_human', arguments: { question: 'Which format — CSV or JSON?' } }
      ]),
      // Turn 2: after the human answers, drafts the verify command
      officerTurn([
        { id: 'b1', name: 'propose_verify', arguments: { command: 'vitest run test/unit/csv.test.ts' } }
      ])
    ]));
    const port = await server();

    const start = await api<IntakeStateDTO>(port, TOKEN, 'POST', '/api/intake', { prompt: 'Let me export tasks' });
    expect(start.statusCode).toBe(200);
    expect(start.body.can_file).toBe(false);
    expect(start.body.latest_question).toContain('CSV or JSON');

    const reply = await api<IntakeStateDTO>(port, TOKEN, 'POST', `/api/intake/${start.body.session_id}/reply`, { message: 'CSV please' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body.verify_cmd).toBe('vitest run test/unit/csv.test.ts');
    expect(reply.body.can_file).toBe(true);
  });

  it('refuses to file until a verify command is confirmable (the human gate)', async () => {
    // Officer proposes intent but no usable verify command.
    setOfficerClientOverride(new MockClient([
      officerTurn([
        { id: 'x1', name: 'propose_field', arguments: { field: 'intent', value: 'Do a thing' } },
        { id: 'x2', name: 'ask_human', arguments: { question: 'What should the check be?' } }
      ])
    ]));
    const port = await server();

    const start = await api<IntakeStateDTO>(port, TOKEN, 'POST', '/api/intake', { prompt: 'Do a thing' });
    expect(start.body.can_file).toBe(false);
    expect(start.body.verify_cmd).toBeNull();

    const filed = await api<any>(port, TOKEN, 'POST', `/api/intake/${start.body.session_id}/confirm-file`, {});
    expect(filed.statusCode).toBe(400);
    expect(filed.body.code).toBe('FILE_REFUSED');

    // No task created; a guardrail span was recorded.
    const task = db.get<any>('SELECT * FROM bureau_tasks WHERE intake_session_id = ?', start.body.session_id);
    expect(task).toBeUndefined();
    const guardrail = db.get<{ count: number }>("SELECT COUNT(*) as count FROM bureau_journal WHERE kind = 'guardrail'");
    expect(guardrail!.count).toBeGreaterThan(0);
  });

  it('refuses a vacuous verify command drafted by the officer', async () => {
    setOfficerClientOverride(new MockClient([
      officerTurn([
        { id: 'v1', name: 'propose_field', arguments: { field: 'intent', value: 'Something' } },
        { id: 'v2', name: 'propose_verify', arguments: { command: 'true' } }
      ])
    ]));
    const port = await server();

    const start = await api<IntakeStateDTO>(port, TOKEN, 'POST', '/api/intake', { prompt: 'Something' });
    expect(start.statusCode).toBe(200);
    // Vacuous command was rejected at the officer tool boundary; never persisted.
    expect(start.body.verify_cmd).toBeNull();
    expect(start.body.can_file).toBe(false);
  });

  it('surfaces a failed officer turn as 502 with a guardrail span', async () => {
    setOfficerClientOverride(new MockClient([new Error('provider unavailable')]));
    const port = await server();

    const start = await api<any>(port, TOKEN, 'POST', '/api/intake', { prompt: 'anything' });
    expect(start.statusCode).toBe(502);
    expect(start.body.code).toBe('INTAKE_TURN_FAILED');

    const guardrail = db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%intake_turn_failed%'"
    );
    expect(guardrail!.count).toBe(1);
  });

  it('rejects an empty prompt and unknown sessions', async () => {
    const port = await server();

    const empty = await api<any>(port, TOKEN, 'POST', '/api/intake', { prompt: '   ' });
    expect(empty.statusCode).toBe(400);

    const missing = await api<any>(port, TOKEN, 'GET', '/api/intake/does-not-exist');
    expect(missing.statusCode).toBe(404);

    const reply = await api<any>(port, TOKEN, 'POST', '/api/intake/does-not-exist/reply', { message: 'hi' });
    expect(reply.statusCode).toBe(404);
  });

  it('refuses unauthenticated intake with 401', async () => {
    const port = await server();
    const res = await api<any>(port, 'wrong-token', 'POST', '/api/intake', { prompt: 'x' });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
