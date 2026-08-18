import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER, type DashboardDTO, type TaskSummaryDTO, type FindingDTO, type JournalEntryDTO } from '../../console/contract.ts';
import type { DbConnection } from '../../engine/contract/types.ts';
import { journal } from '../../engine/journal/writer.ts';

function snapshotDbCounts(db: DbConnection): Record<string, number> {
  const tables = ['bureau_tasks', 'bureau_jobs', 'bureau_journal', 'bureau_verify_runs', 'bureau_watchdog_findings'];
  const snapshot: Record<string, number> = {};
  for (const table of tables) {
    const row = db.get<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`);
    snapshot[table] = row?.count ?? 0;
  }
  return snapshot;
}

function fetchApi<T>(port: number, token: string, path: string): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      {
        method: 'GET',
        headers: {
          [CONSOLE_TOKEN_HEADER]: token
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
            body: data ? JSON.parse(data) : null
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('T-C2: Console Read Endpoints (Milestone A2)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TEST_TOKEN = 'test-secret-token-67890';
  const PLANTED_SECRET = 'bureau-secret-api-key-998877';

  beforeEach(async () => {
    db = createFakeDb();

    // Plant test task with secret title
    db.run(`
      INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, created_at, updated_at)
      VALUES ('task-secret-1', 'Fix task with secret ${PLANTED_SECRET}', 'needs-review', 1, 'work-1', '2026-08-18T10:00:00Z', '2026-08-18T10:00:00Z')
    `);

    // Plant active watchdog finding with secret
    db.run(`
      INSERT INTO bureau_watchdog_findings (id, finding_class, status, detail, detected_at)
      VALUES ('finding-secret-1', 'orphan_worktree', 'active', 'Leak secret: ${PLANTED_SECRET}', '2026-08-18T10:00:00Z')
    `);

    // Plant journal entry with secret
    journal(db, {
      kind: 'system',
      attribution: { actor_role: 'foreman', provider: 'deterministic', model: 'runner', account: 'system' },
      detail: { note: `Journal detail containing ${PLANTED_SECRET}` }
    });
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

  it('matches D0-C DTO shapes across all read endpoints', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const dashRes = await fetchApi<DashboardDTO>(handle.port, TEST_TOKEN, '/api/dashboard');
    expect(dashRes.statusCode).toBe(200);
    expect(Array.isArray(dashRes.body.statePopulations)).toBe(true);
    expect(Array.isArray(dashRes.body.budgetSpend)).toBe(true);
    expect(typeof dashRes.body.verifyFailureRate.failure_rate).toBe('number');
    expect(Array.isArray(dashRes.body.spanKindCounts)).toBe(true);
    expect(typeof dashRes.body.guardrailCount).toBe('number');

    const tasksRes = await fetchApi<TaskSummaryDTO[]>(handle.port, TEST_TOKEN, '/api/tasks');
    expect(tasksRes.statusCode).toBe(200);
    expect(Array.isArray(tasksRes.body)).toBe(true);
    expect(tasksRes.body[0].id).toBe('task-secret-1');

    const findingsRes = await fetchApi<FindingDTO[]>(handle.port, TEST_TOKEN, '/api/findings');
    expect(findingsRes.statusCode).toBe(200);
    expect(Array.isArray(findingsRes.body)).toBe(true);
    expect(findingsRes.body[0].id).toBe('finding-secret-1');

    const journalRes = await fetchApi<JournalEntryDTO[]>(handle.port, TEST_TOKEN, '/api/journal');
    expect(journalRes.statusCode).toBe(200);
    expect(Array.isArray(journalRes.body)).toBe(true);
  });

  it('proves zero database table mutations across a full read pass', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const beforeSnapshot = snapshotDbCounts(db);

    await fetchApi(handle.port, TEST_TOKEN, '/api/dashboard');
    await fetchApi(handle.port, TEST_TOKEN, '/api/tasks');
    await fetchApi(handle.port, TEST_TOKEN, '/api/findings');
    await fetchApi(handle.port, TEST_TOKEN, '/api/journal');

    const afterSnapshot = snapshotDbCounts(db);
    expect(afterSnapshot).toEqual(beforeSnapshot);
  });

  it('guarantees planted secret never appears in any read response', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const endpoints = ['/api/dashboard', '/api/tasks', '/api/findings', '/api/journal'];
    for (const endpoint of endpoints) {
      const res = await fetchApi<any>(handle.port, TEST_TOKEN, endpoint);
      const jsonStr = JSON.stringify(res.body);
      expect(jsonStr).not.toContain(PLANTED_SECRET);
    }
  });
});
