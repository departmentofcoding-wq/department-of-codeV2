import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import {
  CONSOLE_TOKEN_HEADER,
  ENDPOINTS,
  type AssetDTO,
  type CreateAssetRequest,
  type UpdateAssetRequest,
  type DeleteAssetResult,
  type ApiErrorResponse
} from '../../console/contract.ts';
import type { DbConnection, BureauAssetRow } from '../../engine/contract/types.ts';

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
    if (token !== null) {
      headers[CONSOLE_TOKEN_HEADER] = token;
    }

    const req = http.request(
      `http://127.0.0.1:${port}${p}`,
      { method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 500, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ statusCode: res.statusCode || 500, body: data as unknown as T });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('T-C6: Department Assets API & CRUD Machinery', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TOKEN = 'test-token-assets-123';

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

  it('1. GET /api/assets: returns empty array initially, and returns sorted asset array when populated', async () => {
    const port = await server();

    const emptyRes = await api<AssetDTO[]>(port, TOKEN, 'GET', '/api/assets');
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.body).toEqual([]);

    // Insert 2 rows with different updated_at
    db.run(
      `INSERT INTO bureau_assets (id, name, category, url, description, owner, status, created_at, updated_at)
       VALUES ('asset-1', 'Old Asset', 'Google', 'https://old.com', NULL, 'custodian1', 'Active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
              ('asset-2', 'New Asset', 'GitHub', 'https://new.com', 'Repo', 'custodian2', 'Inactive', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`
    );

    const populatedRes = await api<AssetDTO[]>(port, TOKEN, 'GET', '/api/assets');
    expect(populatedRes.statusCode).toBe(200);
    expect(populatedRes.body.length).toBe(2);
    // Should be ordered by updated_at DESC
    expect(populatedRes.body[0].id).toBe('asset-2');
    expect(populatedRes.body[0].name).toBe('New Asset');
    expect(populatedRes.body[0].category).toBe('GitHub');
    expect(populatedRes.body[0].status).toBe('Inactive');
    expect(populatedRes.body[1].id).toBe('asset-1');
  });

  it('2. POST /api/assets: creates asset, defaults category to Other, persists to SQLite, journals span, and returns 201', async () => {
    const port = await server();

    const newAsset: CreateAssetRequest = {
      name: 'Google Workspace Admin',
      url: 'https://admin.google.com',
      description: 'Department GSuite management',
      owner: 'operator@dept.local',
      status: 'Active'
    };

    const res = await api<AssetDTO>(port, TOKEN, 'POST', '/api/assets', newAsset);
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Google Workspace Admin');
    expect(res.body.category).toBe('Other'); // Defaulted because omitted in payload
    expect(res.body.url).toBe('https://admin.google.com');
    expect(res.body.description).toBe('Department GSuite management');
    expect(res.body.owner).toBe('operator@dept.local');
    expect(res.body.status).toBe('Active');
    expect(res.body.created_at).toBeTruthy();
    expect(res.body.updated_at).toBeTruthy();

    // Verify row in DB
    const row = db.get<BureauAssetRow>('SELECT * FROM bureau_assets WHERE id = ?', res.body.id);
    expect(row).toBeDefined();
    expect(row?.name).toBe('Google Workspace Admin');
    expect(row?.category).toBe('Other');

    // Verify journal span
    const journalEntry = db.get<{ kind: string; detail: string }>(
      `SELECT * FROM bureau_journal WHERE detail LIKE '%asset_create%'`
    );
    expect(journalEntry).toBeDefined();
    expect(journalEntry?.kind).toBe('human');
    expect(journalEntry?.detail).toContain(res.body.id);
  });

  it('3. Validation Gate: rejects missing or blank name or url with 400 VALIDATION_ERROR', async () => {
    const port = await server();

    // Missing name
    const resNoName = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/assets', {
      name: '',
      url: 'https://example.com'
    });
    expect(resNoName.statusCode).toBe(400);
    expect(resNoName.body.code).toBe('VALIDATION_ERROR');

    // Missing url
    const resNoUrl = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/assets', {
      name: 'Valid Name',
      url: '   '
    });
    expect(resNoUrl.statusCode).toBe(400);
    expect(resNoUrl.body.code).toBe('VALIDATION_ERROR');
  });

  it('4. POST /api/assets/:id/update: updates fields, refreshes updated_at, validates blank edits, and returns 404 for missing', async () => {
    const port = await server();

    db.run(
      `INSERT INTO bureau_assets (id, name, category, url, description, owner, status, created_at, updated_at)
       VALUES ('asset-update-test', 'Initial Name', 'Cloud', 'https://cloud.com', 'Initial Desc', 'owner-1', 'Active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );

    const updatePayload: UpdateAssetRequest = {
      name: 'Updated Name',
      status: 'Inactive',
      description: 'Updated Desc'
    };

    const res = await api<AssetDTO>(port, TOKEN, 'POST', '/api/assets/asset-update-test/update', updatePayload);
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.status).toBe('Inactive');
    expect(res.body.category).toBe('Cloud'); // Preserved
    expect(res.body.url).toBe('https://cloud.com'); // Preserved
    expect(res.body.description).toBe('Updated Desc');
    expect(res.body.updated_at).not.toBe('2026-01-01T00:00:00.000Z');

    // Reject blank name on update
    const blankRes = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/assets/asset-update-test/update', {
      name: '  '
    });
    expect(blankRes.statusCode).toBe(400);
    expect(blankRes.body.code).toBe('VALIDATION_ERROR');

    // 404 for missing asset
    const missingRes = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/assets/non-existent-id/update', {
      name: 'New'
    });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.body.code).toBe('NOT_FOUND');
  });

  it('5. POST /api/assets/:id/delete: removes asset from database, journals deletion, and returns 404 for missing', async () => {
    const port = await server();

    db.run(
      `INSERT INTO bureau_assets (id, name, category, url, description, owner, status, created_at, updated_at)
       VALUES ('asset-del-test', 'To Delete', 'Google', 'https://del.com', NULL, NULL, 'Active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );

    const res = await api<DeleteAssetResult>(port, TOKEN, 'POST', '/api/assets/asset-del-test/delete');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe('asset-del-test');

    const inDb = db.get<BureauAssetRow>('SELECT * FROM bureau_assets WHERE id = ?', 'asset-del-test');
    expect(inDb).toBeUndefined();

    // Verify journal span
    const journalEntry = db.get<{ kind: string; detail: string }>(
      `SELECT * FROM bureau_journal WHERE detail LIKE '%asset_delete%'`
    );
    expect(journalEntry).toBeDefined();
    expect(journalEntry?.kind).toBe('human');

    // Subsequent delete returns 404
    const res404 = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/assets/asset-del-test/delete');
    expect(res404.statusCode).toBe(404);
    expect(res404.body.code).toBe('NOT_FOUND');
  });

  it('6. Auth Guard: /api/assets endpoints fail-closed (401) and log guardrail journal span when token missing/invalid', async () => {
    const port = await server();

    const noTokenRes = await api<ApiErrorResponse>(port, null, 'GET', '/api/assets');
    expect(noTokenRes.statusCode).toBe(401);
    expect(noTokenRes.body.code).toBe('UNAUTHORIZED');

    const badTokenRes = await api<ApiErrorResponse>(port, 'wrong-token', 'POST', '/api/assets', {
      name: 'Asset',
      url: 'https://example.com'
    });
    expect(badTokenRes.statusCode).toBe(401);

    // Verify guardrail span
    const guardrailSpan = db.get<{ kind: string; detail: string }>(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%console_auth_refusal%'`
    );
    expect(guardrailSpan).toBeDefined();
  });

  it('7. Endpoint Manifest: verifies all assets endpoints exist in ENDPOINTS contract', () => {
    const assetEndpoints = ENDPOINTS.filter((e) => e.path.startsWith('/api/assets'));
    expect(assetEndpoints.length).toBe(4);

    const paths = assetEndpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/assets');
    expect(paths).toContain('POST /api/assets');
    expect(paths).toContain('POST /api/assets/:id/update');
    expect(paths).toContain('POST /api/assets/:id/delete');

    for (const ep of assetEndpoints) {
      expect(ep.auth).toBe('token');
      expect(ep.description).toBeTruthy();
    }
  });
});
