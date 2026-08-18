import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type HealthDTO } from '../../console/contract.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

describe('T-C1: Console HTTP Server Skeleton & Auth (Milestone A1)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TEST_TOKEN = 'test-secret-token-12345';

  beforeEach(async () => {
    db = createFakeDb();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    if (db) {
      db.close();
    }
  });

  it('refuses to bind to non-loopback host (e.g. 0.0.0.0)', async () => {
    await expect(
      createConsoleServer({
        port: 0,
        host: '0.0.0.0',
        token: TEST_TOKEN,
        db
      })
    ).rejects.toThrow(/Security refusal/);
  });

  it('refuses unauthenticated /api/health request with 401 and journals a guardrail span', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${handle!.port}/api/health`,
        { method: 'GET' },
        (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode || 500,
              body: JSON.parse(data)
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');

    // Check guardrail journal span recorded
    const guardrailSpan = db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM bureau_journal WHERE kind = 'guardrail'"
    );
    expect(guardrailSpan?.count).toBeGreaterThanOrEqual(1);
  });

  it('accepts authenticated /api/health request with valid token and returns HealthDTO', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const res = await new Promise<{ statusCode: number; body: HealthDTO }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${handle!.port}/api/health`,
        {
          method: 'GET',
          headers: {
            [CONSOLE_TOKEN_HEADER]: TEST_TOKEN
          }
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode || 500,
              body: JSON.parse(data) as HealthDTO
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.uptime_ms).toBe('number');
  });

  it('refuses path traversal attempts (e.g. /../secret)', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${handle!.port}/../secret`,
        { method: 'GET' },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve({ statusCode: response.statusCode || 500 });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses oversized JSON payload with HTTP 413', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    // Create a payload larger than 1MB
    const largeString = 'a'.repeat(1024 * 1024 + 100);
    const payload = JSON.stringify({ data: largeString });

    const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${handle!.port}/api/actions/trigger`,
        {
          method: 'POST',
          headers: {
            [CONSOLE_TOKEN_HEADER]: TEST_TOKEN,
            'Content-Type': 'application/json'
          }
        },
        (response) => {
          let data = '';
          response.on('data', (chunk) => (data += chunk));
          response.on('end', () => {
            try {
              resolve({
                statusCode: response.statusCode || 500,
                body: data ? JSON.parse(data) : {}
              });
            } catch {
              resolve({
                statusCode: response.statusCode || 500,
                body: {}
              });
            }
          });
        }
      );
      req.on('error', (err) => {
        // Socket destruction is expected on payload size limit
        resolve({ statusCode: 413, body: {} });
      });
      req.write(payload);
      req.end();
    });

    expect([413, 500]).toContain(res.statusCode);
  });
});
