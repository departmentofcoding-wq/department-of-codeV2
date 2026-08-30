import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';
import { slugifyProjectName } from '../../engine/projects/provision.ts';
import { registerProject, projectPathWarnings } from '../../engine/projects/manager.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { drainSingleJob } from '../../runner/main.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import { CONSOLE_TOKEN_HEADER } from '../../console/contract.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

const HUMAN = {
  actor_role: 'human-operator' as const,
  provider: 'human' as const,
  model: 'operator' as const,
  account: 'operator'
};

/**
 * The provisioning front door (the 2026-08-29 'trading analysis' scar): the
 * console enqueued the raw name verbatim (a space in the job id), the slug
 * guard fired INSIDE the job, and three attempts burned into a dead letter.
 * The door now slugifies before enqueueing, and deterministic refusals are
 * NonRetryable — dead on the first failure.
 */

describe('slugifyProjectName (the one derivation, shared with the engine guard)', () => {
  it.each([
    ['trading analysis', 'trading-analysis'],
    ['Trading Data Analysis', 'trading-data-analysis'],
    ['foo_bar baz', 'foo-bar-baz'],
    ['  spaced   out  ', 'spaced-out'],
    ['deps.and--dashes', 'deps.and-dashes'],
    ['keep!!stray$$chars', 'keepstraychars'],
    ['-leading-and-trailing-', 'leading-and-trailing'],
    ['!!!', ''],
    ['   ', ''],
    ['önlÿ unicode', 'nl-unicode']
  ])('slugify(%j) -> %j', (input, expected) => {
    expect(slugifyProjectName(input)).toBe(expected);
  });

  it('every slug it produces passes the engine guard grammar', () => {
    const guard = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    for (const input of ['trading analysis', 'A B', 'x'.repeat(200), 'a - b _ c ! d']) {
      const slug = slugifyProjectName(input);
      if (slug) expect(slug).toMatch(guard);
    }
  });
});

describe('registerProject path warnings (the space-path hazard)', () => {
  let dir: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-door-'));
    db = createRealSqliteDb(path.join(dir, 'bureau.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns on a space-bearing repo path (2026-08-29: D:\\projects\\Trading data analysis)', () => {
    const repo = path.join(dir, 'Trading data analysis');
    fs.mkdirSync(repo);
    execSync('git init -q', { cwd: repo });

    registerProject(db, { name: 'Trading data analysis', pathToRepo: repo, attribution: HUMAN });

    const span = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'project-registered' ORDER BY id DESC LIMIT 1`
    );
    const detail = JSON.parse(span!.detail);
    expect(detail.warnings.length).toBe(1);
    expect(detail.warnings[0]).toContain('spaces');
    expect(projectPathWarnings(repo)).toHaveLength(1);
  });

  it('no warnings for a clean dashed path', () => {
    const repo = path.join(dir, 'trading-data-analysis');
    fs.mkdirSync(repo);
    execSync('git init -q', { cwd: repo });

    registerProject(db, { name: 'trading-data-analysis', pathToRepo: repo, attribution: HUMAN });
    expect(projectPathWarnings(repo)).toHaveLength(0);
  });
});

describe('NonRetryable refusals — dead on the first failure', () => {
  let dir: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-door-nr-'));
    db = createRealSqliteDb(path.join(dir, 'bureau.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('project.provision with an invalid slug dies at attempts=1 (was 3 attempts + 2 wasted guardrail spans)', async () => {
    // Exactly what the OLD door enqueued (raw name, space included).
    const job = enqueueJob(db, {
      kind: 'project.provision',
      payload: { name: 'trading analysis', attribution: HUMAN }
    });
    await drainSingleJob(db, job.id);

    const row = db.get<{ state: string; attempts: number; last_error: string }>(
      'SELECT state, attempts, last_error FROM bureau_jobs WHERE id = ?',
      job.id
    );
    expect(row?.state).toBe('dead');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('not a valid slug');

    // Exactly ONE guardrail refusal — no re-refusal noise on retries.
    const spans = db.all<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%invalid_slug_format%'`
    );
    expect(spans).toHaveLength(1);
  }, 30000);

  it('pr.create refused on task state dies at attempts=1 (the 2026-08-28 zombie shape)', async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, approved_at, approved_by, work_uuid, created_at, updated_at)
       VALUES ('task-nr-1', 'NR test', 'done', 0, ?, 'operator', 'w-nr', ?, ?)`,
      now, now, now
    );
    const job = enqueueJob(db, { kind: 'pr.create', task_id: 'task-nr-1', payload: { taskId: 'task-nr-1' } });
    await drainSingleJob(db, job.id);

    const row = db.get<{ state: string; attempts: number; last_error: string }>(
      'SELECT state, attempts, last_error FROM bureau_jobs WHERE id = ?',
      job.id
    );
    expect(row?.state).toBe('dead');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('must be needs-review');
  }, 30000);
});

describe('POST /api/projects/provision — slugified at the door', () => {
  let db: DbConnection;
  let handle: ConsoleServerHandle;
  let port: number;

  beforeEach(async () => {
    db = createFakeDb();
    handle = await createConsoleServer({ port: 0, token: 'test-token', db });
    port = handle.port;
  });

  afterEach(async () => {
    await handle.close();
    (db as ReturnType<typeof createFakeDb>).close();
  });

  function post(p: string, body: unknown, token = 'test-token'): Promise<{ statusCode: number; body: any }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        `http://127.0.0.1:${port}${p}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
            [CONSOLE_TOKEN_HEADER]: token
          }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ statusCode: res.statusCode || 500, body: data ? JSON.parse(data) : null }));
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it("202: 'trading analysis' enqueues the SLUG (job id without spaces, payload the guard accepts)", async () => {
    const res = await post('/api/projects/provision', { name: 'trading analysis', visibility: 'private' });
    expect(res.statusCode).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.canonicalName).toBe('dept-trading-analysis');
    expect(res.body.jobId).toBe('project.provision:dept-trading-analysis');
    expect(res.body.jobId).not.toContain(' ');

    const job = db.get<{ payload: string }>('SELECT payload FROM bureau_jobs WHERE id = ?', res.body.jobId);
    expect(JSON.parse(job!.payload).name).toBe('trading-analysis');

    // The human span records BOTH the raw input and the derived slug.
    const span = db.get<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE kind = 'human' AND detail LIKE '%project_provision_enqueued%' ORDER BY id DESC LIMIT 1`
    );
    expect(JSON.parse(span!.detail)).toMatchObject({ name: 'trading analysis', slug: 'trading-analysis' });
  });

  it("400: a name with no slug form is refused at the door (no job row, no dead letter)", async () => {
    const res = await post('/api/projects/provision', { name: '!!!' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const count = db.get<{ n: number }>(`SELECT COUNT(*) n FROM bureau_jobs WHERE kind = 'project.provision'`)?.n;
    expect(count).toBe(0);
  });

  it('401 without the token', async () => {
    const res = await post('/api/projects/provision', { name: 'x' }, 'wrong-token');
    expect(res.statusCode).toBe(401);
  });
});
