import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type GoogleKeyStatusDTO } from '../../console/contract.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

const KEY_A = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01';
const KEY_B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB02';

function api<T>(port: number, token: string, method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { [CONSOLE_TOKEN_HEADER]: token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode || 500, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('T-C5: Settings — Google key entry (env-only, never the DB)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  let tmpDir: string;
  const TOKEN = 'settings-token-xyz';
  const saved = { keys: process.env.GOOGLE_API_KEYS, legacy: process.env.GOOGLE_API_KEY, file: process.env.BUREAU_GOOGLE_KEYS_FILE };

  beforeEach(() => {
    db = createFakeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-settings-'));
    process.env.BUREAU_GOOGLE_KEYS_FILE = path.join(tmpDir, 'google.env');
    delete process.env.GOOGLE_API_KEYS;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(async () => {
    if (handle) { await handle.close(); handle = null; }
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.GOOGLE_API_KEYS = saved.keys;
    process.env.GOOGLE_API_KEY = saved.legacy;
    process.env.BUREAU_GOOGLE_KEYS_FILE = saved.file;
    if (saved.keys === undefined) delete process.env.GOOGLE_API_KEYS;
    if (saved.legacy === undefined) delete process.env.GOOGLE_API_KEY;
    if (saved.file === undefined) delete process.env.BUREAU_GOOGLE_KEYS_FILE;
  });

  async function server() {
    handle = await createConsoleServer({ port: 0, token: TOKEN, db });
    return handle.port;
  }

  it('saves keys to env + gitignored file, enables the roster, and journals count only', async () => {
    const port = await server();

    const before = await api<GoogleKeyStatusDTO>(port, TOKEN, 'GET', '/api/settings/google-keys');
    expect(before.body.count).toBe(0);

    const saveRes = await api<GoogleKeyStatusDTO>(port, TOKEN, 'POST', '/api/settings/google-keys', { keys: [KEY_A, KEY_B] });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.count).toBe(2);
    expect(saveRes.body.masked).toEqual(['AIza…AA01', 'AIza…BB02']);

    // Env + file set.
    expect(process.env.GOOGLE_API_KEYS).toBe(`${KEY_A},${KEY_B}`);
    expect(fs.readFileSync(process.env.BUREAU_GOOGLE_KEYS_FILE!, 'utf8')).toContain('GOOGLE_API_KEYS=');

    // Roster enabled live.
    const officer = db.get<any>("SELECT * FROM bureau_assignments WHERE role = 'task-intake-officer'");
    expect(officer.model_id).toBe('gemini-3.1-flash-lite');
    const liteModel = db.get<any>("SELECT * FROM bureau_models WHERE id = 'gemini-3.1-flash-lite'");
    expect(liteModel.enabled).toBe(1);

    // Journal recorded the update with COUNT ONLY.
    const span = db.get<any>("SELECT * FROM bureau_journal WHERE detail LIKE '%settings_keys_updated%'");
    expect(span).not.toBeNull();
    expect(span.detail).toContain('"count":2');

    // No key material anywhere in the DB (journal, meta, models).
    for (const table of ['bureau_journal', 'bureau_meta', 'bureau_models', 'bureau_assignments']) {
      const rows = db.all<any>(`SELECT * FROM ${table}`);
      const blob = JSON.stringify(rows);
      expect(blob).not.toContain(KEY_A);
      expect(blob).not.toContain(KEY_B);
    }

    // GET now reports masked status.
    const after = await api<GoogleKeyStatusDTO>(port, TOKEN, 'GET', '/api/settings/google-keys');
    expect(after.body.count).toBe(2);
    expect(after.body.masked).not.toContain(KEY_A);
  });

  it('rejects invalid keys with 400 + guardrail, writing nothing', async () => {
    const port = await server();
    const res = await api<any>(port, TOKEN, 'POST', '/api/settings/google-keys', { keys: ['not-a-key'] });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_KEYS');
    expect(fs.existsSync(process.env.BUREAU_GOOGLE_KEYS_FILE!)).toBe(false);

    const guard = db.get<any>("SELECT * FROM bureau_journal WHERE detail LIKE '%settings_keys_refused%'");
    expect(guard).not.toBeNull();
  });

  it('refuses unauthenticated key save with 401', async () => {
    const port = await server();
    const res = await api<any>(port, 'wrong', 'POST', '/api/settings/google-keys', { keys: [KEY_A] });
    expect(res.statusCode).toBe(401);
  });
});
