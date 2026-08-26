import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createFakeDb } from '../fixtures/db_factory.ts';
import type { DbConnection, BureauProjectRow, BureauJournalRow, BureauJobRow } from '../../engine/contract/types.ts';
import {
  provisionProject,
  setRepoProviderOverride,
  resetRepoProvider,
  setProjectsRoot,
  getProjectsRoot,
  setRepoPrefix,
  getRepoPrefix,
  setGithubOwner,
  getGithubOwner,
  getProject,
  ProvisionError
} from '../../engine/projects/index.ts';
import { projectProvisionJobId } from '../../engine/jobs/ids.ts';
import { enqueueJobIfAbsent } from '../../engine/jobs/jobs.ts';
import { drainSingleJob } from '../../runner/main.ts';
import { FakeRepoProvider } from '../helpers/fake_repo_provider.ts';

describe('Self-Serve Project Provisioning (Job-Driven Workflow)', () => {
  let db: DbConnection & { close: () => void };
  let fakeRepo: FakeRepoProvider;
  const tempDirs: string[] = [];
  let rootDir: string;

  const operatorAttr = {
    actor_role: 'human-operator' as const,
    provider: 'deterministic',
    model: 'core',
    account: 'operator'
  };

  const juniorAttr = {
    actor_role: 'junior-engineer' as const,
    provider: 'deterministic',
    model: 'core',
    account: 'junior'
  };

  const seniorAttr = {
    actor_role: 'senior-engineer' as const,
    provider: 'deterministic',
    model: 'core',
    account: 'senior'
  };

  const verifierAttr = {
    actor_role: 'verifier' as const,
    provider: 'deterministic',
    model: 'core',
    account: 'verifier'
  };

  beforeEach(() => {
    db = createFakeDb();
    fakeRepo = new FakeRepoProvider();
    setRepoProviderOverride(fakeRepo);

    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-prov-root-'));
    tempDirs.push(rootDir);
    setProjectsRoot(db, rootDir);
  });

  afterEach(() => {
    resetRepoProvider();
    db.close();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    tempDirs.length = 0;
  });

  it('T-PROV-1: Happy Path Provisioning initializes git, creates remote, and registers project', async () => {
    const res = await provisionProject(db, {
      name: 'analytics-hub',
      description: 'Analytics microservice',
      visibility: 'private',
      attribution: juniorAttr
    });

    expect(res.name).toBe('dept-analytics-hub');
    expect(res.github_url).toBe('https://github.com/departmentofcoding-wq/dept-analytics-hub');
    expect(res.provisioned_by).toBe('junior-engineer');
    expect(res.visibility).toBe('private');
    expect(res.description).toBe('Analytics microservice');

    // Local folder & git assertions
    const targetPath = path.join(rootDir, 'dept-analytics-hub');
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.existsSync(path.join(targetPath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(targetPath, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(targetPath, 'README.md'))).toBe(true);

    const gitignoreContent = fs.readFileSync(path.join(targetPath, '.gitignore'), 'utf8');
    expect(gitignoreContent).toContain('/.bureau-worktrees/');

    // RepoProvider called
    expect(fakeRepo.createdRepos).toHaveLength(1);
    expect(fakeRepo.createdRepos[0].name).toBe('dept-analytics-hub');
    expect(fakeRepo.createdRepos[0].visibility).toBe('private');

    // Journal span emitted
    const spans = db.all<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'project-provisioned'"
    );
    expect(spans).toHaveLength(1);
    const detail = JSON.parse(spans[0].detail);
    expect(detail.name).toBe('dept-analytics-hub');
    expect(detail.githubUrl).toBe('https://github.com/departmentofcoding-wq/dept-analytics-hub');
  });

  it('T-PROV-2: Prefix and Canonical Naming respects prefix and avoids double-prefixing', async () => {
    // 1. Unprefixed name gets default prefix 'dept-'
    const p1 = await provisionProject(db, {
      name: 'service-a',
      attribution: juniorAttr
    });
    expect(p1.name).toBe('dept-service-a');

    // 2. Already prefixed name is not double-prefixed
    const p2 = await provisionProject(db, {
      name: 'dept-service-b',
      attribution: juniorAttr
    });
    expect(p2.name).toBe('dept-service-b');

    // 3. Custom prefix configured in bureau_meta
    setRepoPrefix(db, 'team-');
    const p3 = await provisionProject(db, {
      name: 'service-c',
      attribution: juniorAttr
    });
    expect(p3.name).toBe('team-service-c');
  });

  it('T-PROV-3: Slug validation rejects invalid names, path traversal, Windows devices, and collisions', async () => {
    // Invalid characters / traversal
    await expect(provisionProject(db, { name: '', attribution: juniorAttr })).rejects.toThrow(/empty/i);
    await expect(provisionProject(db, { name: '../hack', attribution: juniorAttr })).rejects.toThrow(/invalid/i);
    await expect(provisionProject(db, { name: 'foo/bar', attribution: juniorAttr })).rejects.toThrow(/invalid/i);
    await expect(provisionProject(db, { name: 'foo\\bar', attribution: juniorAttr })).rejects.toThrow(/invalid/i);
    await expect(provisionProject(db, { name: 'invalid@name', attribution: juniorAttr })).rejects.toThrow(/not a valid slug/i);

    // Windows reserved device names
    await expect(provisionProject(db, { name: 'CON', attribution: juniorAttr })).rejects.toThrow(/reserved device name/i);
    await expect(provisionProject(db, { name: 'NUL', attribution: juniorAttr })).rejects.toThrow(/reserved device name/i);
    await expect(provisionProject(db, { name: 'aux', attribution: juniorAttr })).rejects.toThrow(/reserved device name/i);
    await expect(provisionProject(db, { name: 'com1', attribution: juniorAttr })).rejects.toThrow(/reserved device name/i);

    // Initial valid project
    await provisionProject(db, { name: 'alpha', attribution: juniorAttr });

    // Case-insensitive DB collision
    await expect(provisionProject(db, { name: 'ALPHA', attribution: juniorAttr })).rejects.toThrow(/already exists/i);
    await expect(provisionProject(db, { name: 'dept-Alpha', attribution: juniorAttr })).rejects.toThrow(/already exists/i);

    // Directory collision on disk with non-adoptable foreign folder
    const foreignDir = path.join(rootDir, 'dept-foreign');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'package.json'), '{"name":"foreign"}', 'utf8');

    await expect(provisionProject(db, { name: 'foreign', attribution: juniorAttr })).rejects.toThrow(/not an adoptable/i);
  });

  it('T-PROV-4: Path containment guard rejects target paths resolving outside projects_root', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-outside-'));
    tempDirs.push(outsideDir);

    await expect(provisionProject(db, {
      name: 'escaped',
      projectsRoot: outsideDir, // Custom projects root allowed if relative path stays within it
      attribution: juniorAttr
    })).resolves.toBeDefined();

    // Directory traversal escaping projects root
    await expect(provisionProject(db, {
      name: '..',
      attribution: juniorAttr
    })).rejects.toThrow();

    // Traversal via a hostile repoPrefix: the slug check validates only the
    // requested name, so a prefix carrying '../' is the vector ONLY the
    // path-containment guard catches.
    await expect(provisionProject(db, {
      name: 'innocent',
      repoPrefix: '../evil/',
      attribution: juniorAttr
    })).rejects.toThrow(/escapes projects root/i);
  });

  it('T-PROV-5: Actor permissions and visibility gate enforce role boundaries', async () => {
    // 1. Unauthorized actor role is refused
    await expect(provisionProject(db, {
      name: 'verifier-proj',
      attribution: verifierAttr
    })).rejects.toThrow(/not authorized/i);

    const guardrailSpans = db.all<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'guardrail'"
    );
    expect(guardrailSpans.some(s => JSON.parse(s.detail).reason === 'actor_not_authorized')).toBe(true);

    // 2. Junior cannot create public repo
    await expect(provisionProject(db, {
      name: 'junior-public',
      visibility: 'public',
      attribution: juniorAttr
    })).rejects.toThrow(/Only 'human-operator' is permitted to provision public/i);

    // 3. Senior cannot create public repo
    await expect(provisionProject(db, {
      name: 'senior-public',
      visibility: 'public',
      attribution: seniorAttr
    })).rejects.toThrow(/Only 'human-operator' is permitted to provision public/i);

    // 4. Human operator CAN create public repo
    const pubProj = await provisionProject(db, {
      name: 'operator-public',
      visibility: 'public',
      attribution: operatorAttr
    });
    expect(pubProj.visibility).toBe('public');
  });

  it('T-PROV-6: Job idempotency and deterministic ID prevents duplicate executions', async () => {
    const canonicalName = 'dept-idempotent-proj';
    const jobId = projectProvisionJobId(canonicalName);

    const job1 = enqueueJobIfAbsent(db, {
      id: jobId,
      kind: 'project.provision',
      payload: {
        name: 'idempotent-proj',
        attribution: juniorAttr
      }
    });

    const job2 = enqueueJobIfAbsent(db, {
      id: jobId,
      kind: 'project.provision',
      payload: {
        name: 'idempotent-proj',
        attribution: juniorAttr
      }
    });

    expect(job1.inserted).toBe(true);
    expect(job2.inserted).toBe(false);

    // Drain job
    await drainSingleJob(db, jobId);

    const jobRow = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);
    expect(jobRow?.state).toBe('done');

    const project = getProject(db, canonicalName);
    expect(project).toBeDefined();
    expect(project?.name).toBe(canonicalName);
  });

  it('T-PROV-7: Failure honesty ensures no orphaned DB rows on remote failure', async () => {
    fakeRepo.shouldFailCreate = true;
    fakeRepo.failReason = 'GitHub API 500 internal server error';

    await expect(provisionProject(db, {
      name: 'failing-proj',
      attribution: juniorAttr
    })).rejects.toThrow('GitHub API 500 internal server error');

    // Invariant: No orphaned DB row
    const project = getProject(db, 'dept-failing-proj');
    expect(project).toBeNull();

    const projectsInDb = db.all<BureauProjectRow>('SELECT * FROM bureau_projects');
    expect(projectsInDb).toHaveLength(0);
  });

  it('T-PROV-8: Retry and adoption cleanly adopts initialized scaffold on second attempt', async () => {
    // Attempt 1: Fails at remote creation stage after local scaffold is written
    fakeRepo.shouldFailCreate = true;
    await expect(provisionProject(db, {
      name: 'adoptable-proj',
      attribution: juniorAttr
    })).rejects.toThrow();

    // Verify local scaffold exists
    const targetPath = path.join(rootDir, 'dept-adoptable-proj');
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.existsSync(path.join(targetPath, '.git'))).toBe(true);

    // Attempt 2: Remote succeeds -> adopts existing clean scaffold
    fakeRepo.shouldFailCreate = false;
    const res = await provisionProject(db, {
      name: 'adoptable-proj',
      attribution: juniorAttr
    });

    expect(res.name).toBe('dept-adoptable-proj');
    expect(getProject(db, 'dept-adoptable-proj')).toBeDefined();
  });

  it('T-PROV-9: Key hygiene and secret scan confirms zero secrets in SQLite and journal', async () => {
    await provisionProject(db, {
      name: 'secure-proj',
      description: 'Project with no secrets',
      attribution: operatorAttr
    });

    // Scan all database tables for secret patterns
    const secretPatterns = [
      /ghp_[A-Za-z0-9_]{30,}/,
      /github_pat_[A-Za-z0-9_]{22,}/,
      /AIzaSy[A-Za-z0-9_-]{33}/,
      /sk-[A-Za-z0-9]{32,}/
    ];

    const tables = ['bureau_projects', 'bureau_jobs', 'bureau_journal', 'bureau_meta'];
    for (const table of tables) {
      const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      for (const row of rows) {
        const text = JSON.stringify(row);
        for (const pat of secretPatterns) {
          expect(pat.test(text)).toBe(false);
        }
      }
    }
  });
});
