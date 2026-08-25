import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { createConsoleServer, type ConsoleServerHandle } from '../../console/server.ts';
import {
  CONSOLE_TOKEN_HEADER,
  ENDPOINTS,
  type ProjectDTO,
  type CreateProjectRequest,
  type ApiErrorResponse
} from '../../console/contract.ts';
import type { DbConnection, BureauProjectRow } from '../../engine/contract/types.ts';

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

describe('T-C7: Projects API (register + list git repos the bureau works in)', () => {
  let db: DbConnection & { close: () => void };
  let handle: ConsoleServerHandle | null = null;
  const TOKEN = 'test-token-projects-123';
  const tempDirs: string[] = [];

  function createTempGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-proj-api-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    return dir;
  }

  function createTempPlainDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-proj-plain-'));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    db.close();
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs.length = 0;
  });

  async function server() {
    handle = await createConsoleServer({ port: 0, token: TOKEN, db });
    return handle.port;
  }

  it('1. GET /api/projects: empty initially, then lists registered projects', async () => {
    const port = await server();

    const empty = await api<ProjectDTO[]>(port, TOKEN, 'GET', '/api/projects');
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toEqual([]);

    const repo = createTempGitRepo();
    const create: CreateProjectRequest = { name: 'My Repo', pathToRepo: repo, description: 'A test repo' };
    const created = await api<ProjectDTO>(port, TOKEN, 'POST', '/api/projects', create);
    expect(created.statusCode).toBe(201);

    const list = await api<ProjectDTO[]>(port, TOKEN, 'GET', '/api/projects');
    expect(list.statusCode).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].name).toBe('My Repo');
    expect(list.body[0].description).toBe('A test repo');
    // Folder location is recorded (resolved to an absolute path).
    expect(list.body[0].path_to_repo).toBe(path.resolve(repo));
  });

  it('2. POST /api/projects: creates a project, persists the folder, journals a span, returns 201', async () => {
    const port = await server();
    const repo = createTempGitRepo();

    const res = await api<ProjectDTO>(port, TOKEN, 'POST', '/api/projects', {
      name: 'Department of Code',
      pathToRepo: repo,
      description: 'Primary bureau repo'
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Department of Code');
    expect(res.body.path_to_repo).toBe(path.resolve(repo));
    expect(res.body.created_at).toBeTruthy();

    const row = db.get<BureauProjectRow>('SELECT * FROM bureau_projects WHERE id = ?', res.body.id);
    expect(row).toBeDefined();
    expect(row?.path_to_repo).toBe(path.resolve(repo));

    const span = db.get<{ kind: string }>(
      "SELECT * FROM bureau_journal WHERE kind = 'project-registered'"
    );
    expect(span).toBeDefined();
  });

  it('3. Validation: blank name or path returns 400 VALIDATION_ERROR', async () => {
    const port = await server();

    const noName = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/projects', {
      name: '  ',
      pathToRepo: '/tmp/whatever'
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.body.code).toBe('VALIDATION_ERROR');

    const noPath = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/projects', {
      name: 'Named',
      pathToRepo: ''
    });
    expect(noPath.statusCode).toBe(400);
    expect(noPath.body.code).toBe('VALIDATION_ERROR');
  });

  it('4. Folder gate: a path that is not a git repo is refused (400 PROJECT_REFUSED), guardrail journaled', async () => {
    const port = await server();
    const plain = createTempPlainDir();

    const res = await api<ApiErrorResponse>(port, TOKEN, 'POST', '/api/projects', {
      name: 'Not A Repo',
      pathToRepo: plain
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PROJECT_REFUSED');

    // Nothing persisted.
    const rows = db.all<BureauProjectRow>('SELECT * FROM bureau_projects');
    expect(rows.length).toBe(0);

    const guardrail = db.get<{ kind: string; detail: string }>(
      "SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%project_register_refused%'"
    );
    expect(guardrail).toBeDefined();
  });

  it('5. Auth guard: /api/projects fails closed (401) when the token is missing or wrong', async () => {
    const port = await server();

    const noToken = await api<ApiErrorResponse>(port, null, 'GET', '/api/projects');
    expect(noToken.statusCode).toBe(401);
    expect(noToken.body.code).toBe('UNAUTHORIZED');

    const badToken = await api<ApiErrorResponse>(port, 'wrong', 'POST', '/api/projects', {
      name: 'X',
      pathToRepo: '/tmp/x'
    });
    expect(badToken.statusCode).toBe(401);
  });

  it('6. Endpoint manifest: both project endpoints are declared and token-guarded', () => {
    const projectEndpoints = ENDPOINTS.filter((e) => e.path.startsWith('/api/projects'));
    expect(projectEndpoints.length).toBe(2);
    const paths = projectEndpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/projects');
    expect(paths).toContain('POST /api/projects');
    for (const ep of projectEndpoints) {
      expect(ep.auth).toBe('token');
      expect(ep.description).toBeTruthy();
    }
  });
});
