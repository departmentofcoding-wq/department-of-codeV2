import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttributionTuple, DbConnection } from '../../engine/contract/index.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { journal } from '../../engine/journal/writer.ts';
import { workerRoster, WORKER_ACTIVE_WINDOW_MS } from '../../engine/dashboards/views.ts';
import { renderWorkers } from '../../console/public/render.js';

const JR: AttributionTuple = { actor_role: 'junior-engineer', provider: 'antigravity', model: 'gemini-3.7-flash', account: null };

describe('workerRoster + renderWorkers', () => {
  let tmp: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-'));
    db = createRealSqliteDb(path.join(tmp, 'w.db'));
    const now = new Date().toISOString();
    // A model + assignment (junior-engineer -> a real model)
    db.run(`INSERT OR REPLACE INTO bureau_models (id, provider, display, enabled) VALUES ('gemini-3.7-flash', 'antigravity', 'Gemini 3.7 Flash', 1)`);
    db.run(`INSERT OR REPLACE INTO bureau_assignments (role, backend, model_id, updated_at) VALUES ('junior-engineer', 'antigravity-cdp', 'gemini-3.7-flash', ?)`, now);
    // Task for the journal FK + a recent junior span => active
    db.run(`INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES ('t1','T','u1',?,?)`, now, now);
    journal(db, { kind: 'dispatch', attribution: JR, taskId: 't1', detail: { status: 'running' } });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists assigned roles with model/provider and marks recent activity active', () => {
    const roster = workerRoster(db);
    const jr = roster.find(w => w.role === 'junior-engineer')!;
    expect(jr.provider).toBe('antigravity');
    expect(jr.display).toBe('Gemini 3.7 Flash');
    expect(jr.active).toBe(true); // just journaled a span
    expect(jr.last_activity_kind).toBe('dispatch');
  });

  it('marks a worker idle when its last activity is older than the active window', () => {
    // Evaluate "now" far in the future so the recent span is stale.
    const future = Date.now() + WORKER_ACTIVE_WINDOW_MS + 60_000;
    const roster = workerRoster(db, future);
    const jr = roster.find(w => w.role === 'junior-engineer')!;
    expect(jr.active).toBe(false);
  });

  it('shows a worker active while its job is RUNNING, even with no recent span', () => {
    const now = new Date().toISOString();
    // A running work.cycle engages the senior (and junior) for the WHOLE duration,
    // even a long review that only journals when it finishes.
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, created_at, started_at)
       VALUES ('job-wc', 'work.cycle', 't1', '{}', 'running', 1, 1, ?, ?)`,
      now, now
    );
    // Evaluate far in the future so no journal span is "recent" — only the
    // running job can keep a worker active.
    const future = Date.now() + WORKER_ACTIVE_WINDOW_MS + 60_000;
    const roster = workerRoster(db, future);
    const senior = roster.find(w => w.role === 'senior-engineer');
    expect(senior?.active).toBe(true);
    expect(senior?.running_jobs).toBe(1);
  });

  it('renderWorkers escapes and shows an active indicator', () => {
    const html = renderWorkers([
      { role: 'junior-engineer', backend: 'antigravity-cdp', model_id: 'gemini-3.7-flash', provider: 'antigravity', display: 'Gemini 3.7 Flash', active: true, active_leases: 0, running_dispatches: 1, running_jobs: 0, last_activity_ts: '2026-08-20T00:00:00Z', last_activity_kind: 'dispatch' }
    ]);
    expect(html).toContain('worker-dot active');
    expect(html).toContain('junior-engineer');
    expect(html).toContain('1 of 1 workers active');
  });
});
