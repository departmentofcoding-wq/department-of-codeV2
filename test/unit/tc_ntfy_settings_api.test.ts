import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type NtfySettingsDTO, type SaveNtfySettingsRequest } from '../../console/contract.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

function api<T>(
  port: number,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        [CONSOLE_TOKEN_HEADER]: token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode || 500,
        body: data ? JSON.parse(data) : null
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('T-C7: Settings — Ntfy notifications API & persistence in bureau_meta', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TOKEN = 'test-console-token';

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

  it('loads default ntfy settings when none are stored in bureau_meta', async () => {
    const port = await server();

    const res = await api<NtfySettingsDTO>(port, TOKEN, 'GET', '/api/settings/ntfy');
    expect(res.statusCode).toBe(200);
    expect(res.body.ntfy_server_url).toBe('https://ntfy.sh');
    expect(res.body.ntfy_topic).toBe('');
    expect(res.body.enabled).toBe(false);
  });

  it('persists ntfy settings to bureau_meta and journals update', async () => {
    const port = await server();

    const postRes = await api<NtfySettingsDTO>(port, TOKEN, 'POST', '/api/settings/ntfy', {
      ntfy_server_url: 'https://ntfy.mycorp.internal',
      ntfy_topic: 'bureau-ops-channel'
    } as SaveNtfySettingsRequest);

    expect(postRes.statusCode).toBe(200);
    expect(postRes.body.ntfy_server_url).toBe('https://ntfy.mycorp.internal');
    expect(postRes.body.ntfy_topic).toBe('bureau-ops-channel');
    expect(postRes.body.enabled).toBe(true);

    // Verify row directly in bureau_meta
    const serverUrlRow = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', 'ntfy_server_url');
    const topicRow = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', 'ntfy_topic');
    expect(serverUrlRow?.value).toBe('https://ntfy.mycorp.internal');
    expect(topicRow?.value).toBe('bureau-ops-channel');

    // Journal entry recorded
    const journalEntry = db.get<any>("SELECT * FROM bureau_journal WHERE detail LIKE '%settings_ntfy_updated%'");
    expect(journalEntry).not.toBeNull();

    // GET reflects persisted settings
    const getRes = await api<NtfySettingsDTO>(port, TOKEN, 'GET', '/api/settings/ntfy');
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.ntfy_server_url).toBe('https://ntfy.mycorp.internal');
    expect(getRes.body.ntfy_topic).toBe('bureau-ops-channel');
    expect(getRes.body.enabled).toBe(true);
  });

  it('rejects invalid server URL with 400 INVALID_URL', async () => {
    const port = await server();

    const res = await api<any>(port, TOKEN, 'POST', '/api/settings/ntfy', {
      ntfy_server_url: 'invalid-url-schema',
      ntfy_topic: 'bureau-ops'
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_URL');
  });

  it('refuses unauthenticated requests with 401', async () => {
    const port = await server();

    const getRes = await api<any>(port, 'bad-token', 'GET', '/api/settings/ntfy');
    expect(getRes.statusCode).toBe(401);

    const postRes = await api<any>(port, 'bad-token', 'POST', '/api/settings/ntfy', {
      ntfy_topic: 'test'
    });
    expect(postRes.statusCode).toBe(401);
  });
});
