import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import {
  CONSOLE_TOKEN_HEADER,
  type ApproveTaskResult,
  type TriggerActionResult
} from '../../console/contract.ts';
import type { DbConnection, BureauJobRow } from '../../engine/contract/types.ts';

function postApi<T>(port: number, token: string, path: string, body: unknown): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      {
        method: 'POST',
        headers: {
          [CONSOLE_TOKEN_HEADER]: token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
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
    req.write(payload);
    req.end();
  });
}

describe('T-C3: Console Action Endpoints & Approval Core (Milestone A3)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TEST_TOKEN = 'test-action-token-112233';

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

  it('refuses approval on unverified task (verifier_exit_code != 0) with guardrail span', async () => {
    // Seed task with verifier_exit_code = 1
    db.run(`
      INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, priority, work_uuid, created_at, updated_at)
      VALUES ('task-fail-ver', 'Unverified Task', 'needs-review', 1, 1, 'work-1', '2026-08-18T10:00:00Z', '2026-08-18T10:00:00Z')
    `);

    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const res = await postApi<any>(handle.port, TEST_TOKEN, '/api/tasks/task-fail-ver/approve', {
      approvedBy: 'senior-operator'
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('APPROVAL_REFUSED');

    // Assert task remains unapproved
    const task = db.get<any>("SELECT * FROM bureau_tasks WHERE id = 'task-fail-ver'");
    expect(task.approved_at).toBeNull();
    expect(task.approved_by).toBeNull();

    // Assert guardrail span recorded
    const guardrail = db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-fail-ver'"
    );
    expect(guardrail?.count).toBe(1);
  });

  it('approves a verified task: sets approval columns, retains state needs-review, enqueues pr.create, and journals human span', async () => {
    // Seed verified task (verifier_exit_code = 0, state = 'needs-review')
    db.run(`
      INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, priority, work_uuid, created_at, updated_at)
      VALUES ('task-verified-1', 'Verified Task', 'needs-review', 0, 1, 'work-2', '2026-08-18T10:00:00Z', '2026-08-18T10:00:00Z')
    `);

    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const res = await postApi<ApproveTaskResult>(handle.port, TEST_TOKEN, '/api/tasks/task-verified-1/approve', {
      approvedBy: 'alice-operator'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.task_id).toBe('task-verified-1');
    expect(res.body.state).toBe('needs-review');
    expect(res.body.approved_by).toContain('alice-operator');
    expect(typeof res.body.approved_at).toBe('string');

    // Check DB state
    const task = db.get<any>("SELECT * FROM bureau_tasks WHERE id = 'task-verified-1'");
    expect(task.state).toBe('needs-review');
    expect(task.approved_by).toContain('alice-operator');
    expect(task.approved_at).not.toBeNull();

    // Check pr.create job enqueued
    const job = db.get<BureauJobRow>("SELECT * FROM bureau_jobs WHERE kind = 'pr.create' AND task_id = 'task-verified-1'");
    expect(job).not.toBeNull();
    expect(job?.state).toBe('pending');

    // Check human span recorded in journal
    const span = db.get<any>("SELECT * FROM bureau_journal WHERE kind = 'human' AND task_id = 'task-verified-1'");
    expect(span).not.toBeNull();
    expect(span.actor_role).toBe('human-operator');
  });

  it('triggers watchdog.sweep or backup.push job via enqueueJobIfAbsent (idempotent)', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const firstRes = await postApi<TriggerActionResult>(handle.port, TEST_TOKEN, '/api/actions/trigger', {
      kind: 'watchdog.sweep',
      target: 'system'
    });

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.body.ok).toBe(true);
    expect(firstRes.body.kind).toBe('watchdog.sweep');
    expect(firstRes.body.job_id).toBe('console-watchdog.sweep-system');

    // Verify job in DB
    const jobsCount = db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM bureau_jobs WHERE id = 'console-watchdog.sweep-system'"
    );
    expect(jobsCount?.count).toBe(1);

    // Call again (idempotency check)
    const secondRes = await postApi<TriggerActionResult>(handle.port, TEST_TOKEN, '/api/actions/trigger', {
      kind: 'watchdog.sweep',
      target: 'system'
    });

    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.body.job_id).toBe(firstRes.body.job_id);

    // Verify exactly 1 job exists (no duplicate)
    const jobsCountAfter = db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM bureau_jobs WHERE id = 'console-watchdog.sweep-system'"
    );
    expect(jobsCountAfter?.count).toBe(1);
  });

  it('refuses unauthenticated POST actions with 401', async () => {
    handle = await createConsoleServer({
      port: 0,
      token: TEST_TOKEN,
      db
    });

    const res = await postApi<any>(handle.port, 'wrong-token', '/api/actions/trigger', {
      kind: 'backup.push'
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
