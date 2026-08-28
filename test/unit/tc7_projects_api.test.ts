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

  it('6. Endpoint manifest: all project endpoints are declared and token-guarded', () => {
    const projectEndpoints = ENDPOINTS.filter((e) => e.path.startsWith('/api/projects'));
    expect(projectEndpoints.length).toBe(3);
    const paths = projectEndpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/projects');
    expect(paths).toContain('POST /api/projects');
    expect(paths).toContain('POST /api/projects/provision');
    for (const ep of projectEndpoints) {
      expect(ep.auth).toBe('token');
      expect(ep.description).toBeTruthy();
    }
  });

  it('7. POST /api/projects/provision: enqueues project.provision job with deterministic id, returns 202', async () => {
    const port = await server();

    const res = await api<{ ok: boolean; jobId: string; canonicalName: string; state: string }>(
      port,
      TOKEN,
      'POST',
      '/api/projects/provision',
      {
        name: 'my-new-app',
        description: 'A newly provisioned project',
        visibility: 'private'
      }
    );

    expect(res.statusCode).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe('project.provision:dept-my-new-app');
    expect(res.body.canonicalName).toBe('dept-my-new-app');
    expect(res.body.state).toBe('pending');

    // Verify job row in DB
    const job = db.get<{ id: string; kind: string; payload: string; state: string }>(
      'SELECT * FROM bureau_jobs WHERE id = ?',
      res.body.jobId
    );
    expect(job).toBeDefined();
    expect(job?.kind).toBe('project.provision');
    expect(job?.state).toBe('pending');
    const payload = JSON.parse(job!.payload);
    expect(payload.name).toBe('my-new-app');
    expect(payload.visibility).toBe('private');
    expect(payload.attribution.actor_role).toBe('human-operator');

    // Verify human journal entry
    const journalEntry = db.get<{ kind: string; detail: string }>(
      "SELECT * FROM bureau_journal WHERE kind = 'human' AND job_id = ?",
      res.body.jobId
    );
    expect(journalEntry).toBeDefined();
    const detail = JSON.parse(journalEntry!.detail);
    expect(detail.action).toBe('project_provision_enqueued');
  });

  it('8. POST /api/projects/provision: Idempotency — duplicate calls return identical jobId without duplicating rows', async () => {
    const port = await server();

    const res1 = await api<{ ok: boolean; jobId: string; canonicalName: string }>(
      port,
      TOKEN,
      'POST',
      '/api/projects/provision',
      { name: 'idempotent-proj' }
    );
    expect(res1.statusCode).toBe(202);

    const res2 = await api<{ ok: boolean; jobId: string; canonicalName: string }>(
      port,
      TOKEN,
      'POST',
      '/api/projects/provision',
      { name: 'idempotent-proj' }
    );
    expect(res2.statusCode).toBe(202);
    expect(res1.body.jobId).toBe(res2.body.jobId);

    const jobs = db.all<{ id: string }>(
      'SELECT * FROM bureau_jobs WHERE id = ?',
      res1.body.jobId
    );
    expect(jobs.length).toBe(1);
  });

  it('9. POST /api/projects/provision: Validation — blank name returns 400 VALIDATION_ERROR', async () => {
    const port = await server();

    const blankName = await api<ApiErrorResponse>(
      port,
      TOKEN,
      'POST',
      '/api/projects/provision',
      { name: '   ' }
    );
    expect(blankName.statusCode).toBe(400);
    expect(blankName.body.code).toBe('VALIDATION_ERROR');

    const missingName = await api<ApiErrorResponse>(
      port,
      TOKEN,
      'POST',
      '/api/projects/provision',
      {}
    );
    expect(missingName.statusCode).toBe(400);
    expect(missingName.body.code).toBe('VALIDATION_ERROR');
  });

  it('10. POST /api/projects/provision: Auth gate — fails closed (401) without valid token', async () => {
    const port = await server();

    const noToken = await api<ApiErrorResponse>(
      port,
      null,
      'POST',
      '/api/projects/provision',
      { name: 'unauth-proj' }
    );
    expect(noToken.statusCode).toBe(401);
    expect(noToken.body.code).toBe('UNAUTHORIZED');

    const badToken = await api<ApiErrorResponse>(
      port,
      'invalid-token',
      'POST',
      '/api/projects/provision',
      { name: 'unauth-proj' }
    );
    expect(badToken.statusCode).toBe(401);
    expect(badToken.body.code).toBe('UNAUTHORIZED');
  });

  it('11. Polling via GET /api/journal?job_id=<jobId> reflects job state through all transitions', async () => {
    const { FakeRepoProvider } = await import('../helpers/fake_repo_provider.ts');
    const { setRepoProviderOverride, resetRepoProvider, setProjectsRoot } = await import('../../engine/projects/index.ts');
    const { drainSingleJob } = await import('../../runner/main.ts');

    const fakeRepo = new FakeRepoProvider();
    setRepoProviderOverride(fakeRepo);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-poll-test-'));
    tempDirs.push(root);
    setProjectsRoot(db, root);

    try {
      const port = await server();

      // 1. Enqueue provision job
      const provRes = await api<{ ok: boolean; jobId: string; canonicalName: string }>(
        port,
        TOKEN,
        'POST',
        '/api/projects/provision',
        { name: 'pollable-proj', description: 'Testing polling flow' }
      );
      expect(provRes.statusCode).toBe(202);
      const jobId = provRes.body.jobId;

      // 2. Poll before drain: only human enqueued span present, no project-provisioned span yet
      const pollPending = await api<Array<{ kind: string; job_id: string }>>(
        port,
        TOKEN,
        'GET',
        `/api/journal?job_id=${encodeURIComponent(jobId)}`
      );
      expect(pollPending.statusCode).toBe(200);
      expect(pollPending.body.some(s => s.kind === 'project-provisioned')).toBe(false);

      // 3. Drain the job with FakeRepoProvider
      await drainSingleJob(db, jobId);

      // 4. Poll after drain: project-provisioned span is now present
      const pollDone = await api<Array<{ kind: string; job_id: string; detail: string }>>(
        port,
        TOKEN,
        'GET',
        `/api/journal?job_id=${encodeURIComponent(jobId)}`
      );
      expect(pollDone.statusCode).toBe(200);
      const provisionedSpan = pollDone.body.find(s => s.kind === 'project-provisioned');
      expect(provisionedSpan).toBeDefined();

      // 5. Verify project is now in GET /api/projects with github_url
      const projList = await api<ProjectDTO[]>(port, TOKEN, 'GET', '/api/projects');
      expect(projList.statusCode).toBe(200);
      const found = projList.body.find(p => p.name === 'dept-pollable-proj');
      expect(found).toBeDefined();
      expect(found?.github_url).toContain('https://github.com/');

      // 6. Test failure polling transition
      fakeRepo.shouldFailCreate = true;
      fakeRepo.failReason = 'Injected failure for polling test';
      const failRes = await api<{ ok: boolean; jobId: string }>(
        port,
        TOKEN,
        'POST',
        '/api/projects/provision',
        { name: 'failing-proj' }
      );
      expect(failRes.statusCode).toBe(202);
      const failJobId = failRes.body.jobId;

      await drainSingleJob(db, failJobId);

      const pollFailed = await api<Array<{ kind: string; job_id: string; detail: string }>>(
        port,
        TOKEN,
        'GET',
        `/api/journal?job_id=${encodeURIComponent(failJobId)}`
      );
      expect(pollFailed.statusCode).toBe(200);
      const guardrailSpan = pollFailed.body.find(s => s.kind === 'guardrail');
      expect(guardrailSpan).toBeDefined();
    } finally {
      resetRepoProvider();
    }
  });

  it('12. GET /api/settings/github: returns masked shape composed from fake provider + DB config', async () => {
    const { FakeRepoProvider } = await import('../helpers/fake_repo_provider.ts');
    const { setRepoProviderOverride, resetRepoProvider, setProjectsRoot, setRepoPrefix } = await import('../../engine/projects/index.ts');

    const fakeRepo = new FakeRepoProvider();
    fakeRepo.authStatus = {
      authenticated: true,
      login: 'bureau-test-user',
      scopes: ['repo', 'read:org', 'admin:org_hook']
    };
    setRepoProviderOverride(fakeRepo);

    setProjectsRoot(db, 'D:\\custom\\projects\\root');
    setRepoPrefix(db, 'dept-');

    try {
      const port = await server();

      const res = await api<{
        authenticated: boolean;
        login: string | null;
        scopes: string[];
        projects_root: string;
        repo_prefix: string;
      }>(port, TOKEN, 'GET', '/api/settings/github');

      expect(res.statusCode).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.login).toBe('bureau-test-user');
      expect(res.body.scopes).toEqual(['repo', 'read:org', 'admin:org_hook']);
      expect(res.body.projects_root).toBe('D:\\custom\\projects\\root');
      expect(res.body.repo_prefix).toBe('dept-');
    } finally {
      resetRepoProvider();
    }
  });

  it('13. Whole-Response Key Hygiene: serialized response asserts absence of secret tokens', async () => {
    const { FakeRepoProvider } = await import('../helpers/fake_repo_provider.ts');
    const { setRepoProviderOverride, resetRepoProvider } = await import('../../engine/projects/index.ts');

    const fakeRepo = new FakeRepoProvider();
    setRepoProviderOverride(fakeRepo);

    try {
      const port = await server();

      // Raw http request to inspect raw headers + body text
      const rawRes = await new Promise<{ headers: http.IncomingHttpHeaders; rawBody: string }>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/settings/github`,
          {
            method: 'GET',
            headers: { [CONSOLE_TOKEN_HEADER]: TOKEN }
          },
          (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ headers: res.headers, rawBody: body }));
          }
        );
        req.on('error', reject);
        req.end();
      });

      const serialized = JSON.stringify(rawRes.headers) + ' ' + rawRes.rawBody;

      // Scan for any pattern of GitHub token prefixes
      const tokenRegex = /(ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})/;
      expect(tokenRegex.test(serialized)).toBe(false);
    } finally {
      resetRepoProvider();
    }
  });
});

