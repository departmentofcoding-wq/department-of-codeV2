import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { setNtfyTransportOverride } from '../../engine/notifications/ntfy-seam.ts';
import type { NtfyTransport } from '../../engine/notifications/ntfy.ts';
import {
  CONSOLE_TOKEN_HEADER,
  type NtfySettingsDTO,
  type TestNtfyResult
} from '../../console/contract.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

function api<T>(port: number, token: string, method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      [CONSOLE_TOKEN_HEADER]: token
    };
    const req = http.request(`http://127.0.0.1:${port}${p}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode || 500, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('T-NTFY: Settings ntfy API (events list + test push)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  const TOKEN = 'ntfy-settings-token';

  const capture: NtfyTransport = {
    async post(url, _body, headers) {
      calls.push({ url, headers });
      return { status: 200, text: 'ok' };
    }
  };

  beforeEach(() => {
    db = createFakeDb();
    calls = [];
    setNtfyTransportOverride(capture);
  });

  afterEach(async () => {
    setNtfyTransportOverride(null);
    if (handle) { await handle.close(); handle = null; }
    db.close();
  });

  async function server() {
    handle = await createConsoleServer({ port: 0, token: TOKEN, db });
    return handle.port;
  }

  it('1. GET /api/settings/ntfy includes the events catalog (what sends notifications)', async () => {
    const port = await server();
    const res = await api<NtfySettingsDTO>(port, TOKEN, 'GET', '/api/settings/ntfy');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    const keys = (res.body.events || []).map(e => e.key);
    expect(keys).toContain('dept.online');
    expect(keys).toContain('task.needs-review');
    expect(keys).toContain('task.started');
    expect(keys).toContain('ntfy.test');
  });

  it('2. POST /api/settings/ntfy/test reports configured:false when no topic is set', async () => {
    const port = await server();
    const res = await api<TestNtfyResult>(port, TOKEN, 'POST', '/api/settings/ntfy/test', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.sent).toBe(false);
    expect(res.body.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('3. POST /api/settings/ntfy/test sends a test push when a topic is configured', async () => {
    const port = await server();
    await api(port, TOKEN, 'POST', '/api/settings/ntfy', { ntfy_server_url: 'https://ntfy.sh', ntfy_topic: 'my-topic' });

    const res = await api<TestNtfyResult>(port, TOKEN, 'POST', '/api/settings/ntfy/test', {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.configured).toBe(true);
    expect(res.body.sent).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://ntfy.sh/my-topic');
    expect(calls[0].headers['Title']).toContain('Test notification');
  });
});
