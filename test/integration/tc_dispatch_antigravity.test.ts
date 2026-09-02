import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbConnection } from '../../engine/db/index.ts';
import type { BureauDispatchRow, BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { setAntigravityDriverOverride, type AntigravityDriver } from '../../engine/harness/antigravity-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';

describe('junior.dispatch → Antigravity prompt path', () => {
  let tmpDir: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-disp-'));
    db = openDbConnection(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at, assigned_junior, assigned_senior, assigned_at)
      VALUES ('task-ag', 'AG Task', 'uuid-ag', '${now}', '${now}', 'B', 'claude', '${now}');
      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-ag', 'task-ag', 'uuid-ag', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 0, '${now}');
      INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
      VALUES ('job-ag', 'junior.dispatch', 'task-ag', 'running', '${now}');
    `);
  });

  afterEach(() => {
    setAntigravityDriverOverride(null);
    setWorkspaceProvider(null);
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes a prompt payload to the Antigravity driver and journals the transcript', async () => {
    let received = '';
    const fake: AntigravityDriver = {
      async runCommand(prompt) {
        received = prompt;
        return { transcript: 'agent: DEPARTMENT ONLINE', launched: false };
      }
    };
    setAntigravityDriverOverride(fake);

    const ctx: any = {
      db,
      job: { id: 'job-ag', task_id: 'task-ag' },
      payload: { dispatchId: 'disp-ag', prompt: 'add a function add(a,b) with a test' },
      signal: new AbortController().signal
    };
    await handleJuniorDispatch(ctx);

    // The command reached the Antigravity driver.
    expect(received).toBe('add a function add(a,b) with a test');

    // The dispatch completed.
    const disp = db.get<BureauDispatchRow>('SELECT * FROM bureau_dispatches WHERE id = ?', 'disp-ag');
    expect(disp?.status).toBe('completed');

    // An attributed observation span carries the agent transcript.
    const obs = db.all<BureauJournalRow>(`SELECT * FROM bureau_journal WHERE kind = 'observation'`);
    expect(obs.length).toBe(1);
    const detail = JSON.parse(obs[0].detail as string);
    expect(detail.source).toBe('antigravity');
    expect(detail.transcriptTail).toContain('DEPARTMENT ONLINE');
    expect(detail.prompt).toBe('add a function add(a,b) with a test');
  });

  it('chainWorkReview: on completion, a plan-originated implementation dispatch enqueues a work.cycle so a senior reads the walkthrough', async () => {
    setAntigravityDriverOverride({
      async runCommand() {
        return { transcript: 'agent: implemented + walkthrough', launched: false };
      }
    });

    const ctx: any = {
      db,
      job: { id: 'job-ag', task_id: 'task-ag' },
      payload: { dispatchId: 'disp-ag', prompt: 'implement the approved plan', chainWorkReview: true },
      signal: new AbortController().signal
    };
    await handleJuniorDispatch(ctx);

    // The loop is closed: a work.cycle job for this task is now pending.
    const work = db.get<any>(
      `SELECT * FROM bureau_jobs WHERE kind = 'work.cycle' AND task_id = 'task-ag'`
    );
    expect(work).toBeTruthy();
    expect(work.state).toBe('pending');
    expect(JSON.parse(work.payload).taskId).toBe('task-ag');
  });

  it('points the junior at the task worktree for a delivery dispatch (chainWorkReview) when a provider is registered', async () => {
    const provider = new FakeWorkspaceProvider();
    setWorkspaceProvider(provider);
    const handle = await provider.prepare(db, 'task-ag'); // the path the junior must be pointed at

    let sawFolder: string | undefined = 'UNSET';
    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        sawFolder = opts?.folder;
        return { transcript: 'agent: implemented in worktree', launched: false };
      }
    });

    const ctx: any = {
      db,
      job: { id: 'job-ag', task_id: 'task-ag' },
      payload: { dispatchId: 'disp-ag', prompt: 'implement the approved plan', chainWorkReview: true, folder: 'C:/some/other/place' },
      signal: new AbortController().signal
    };
    await handleJuniorDispatch(ctx);

    // The junior was pointed at the bureau worktree, NOT the caller's folder.
    expect(sawFolder).toBe(handle.path);
    const span = db.get<any>(
      `SELECT * FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%junior_pointed_at_worktree%'`
    );
    expect(span).toBeTruthy();
    expect(JSON.parse(span.detail).path).toBe(handle.path);
  });

  it('does NOT redirect a non-delivery dispatch (no chainWorkReview): keeps the caller folder even with a provider', async () => {
    setWorkspaceProvider(new FakeWorkspaceProvider());
    let sawFolder: string | undefined = 'UNSET';
    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        sawFolder = opts?.folder;
        return { transcript: 'agent: did a thing', launched: false };
      }
    });
    const ctx: any = {
      db,
      job: { id: 'job-ag', task_id: 'task-ag' },
      payload: { dispatchId: 'disp-ag', prompt: 'do a thing', folder: 'C:/caller/folder' },
      signal: new AbortController().signal
    };
    await handleJuniorDispatch(ctx);
    expect(sawFolder).toBe('C:/caller/folder');
  });

  it('NO chaining by default: an ordinary dispatch (no chainWorkReview) enqueues no work.cycle', async () => {
    setAntigravityDriverOverride({
      async runCommand() {
        return { transcript: 'agent: did a thing', launched: false };
      }
    });
    const ctx: any = {
      db,
      job: { id: 'job-ag', task_id: 'task-ag' },
      payload: { dispatchId: 'disp-ag', prompt: 'do a thing' },
      signal: new AbortController().signal
    };
    await handleJuniorDispatch(ctx);
    expect(db.get<any>(`SELECT COUNT(*) n FROM bureau_jobs WHERE kind = 'work.cycle'`).n).toBe(0);
  });
});
