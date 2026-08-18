import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDbConnection } from '../../engine/db/index.ts';
import type { BureauDispatchRow, BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { setAntigravityDriverOverride, type AntigravityDriver } from '../../engine/harness/antigravity-seam.ts';

describe('junior.dispatch → Antigravity prompt path', () => {
  let tmpDir: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-disp-'));
    db = openDbConnection(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
      VALUES ('task-ag', 'AG Task', 'uuid-ag', '${now}', '${now}');
      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-ag', 'task-ag', 'uuid-ag', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 0, '${now}');
      INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
      VALUES ('job-ag', 'junior.dispatch', 'task-ag', 'running', '${now}');
    `);
  });

  afterEach(() => {
    setAntigravityDriverOverride(null);
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
});
