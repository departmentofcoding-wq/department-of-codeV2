import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttributionTuple, DbConnection } from '../../engine/contract/index.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { journal } from '../../engine/journal/writer.ts';
import {
  dashboardSnapshot,
  budgetSpend,
  statePopulations,
  verifyFailureRate,
  guardrailCount
} from '../../engine/dashboards/views.ts';

const SYS: AttributionTuple = { actor_role: 'system', provider: 'deterministic', model: 'core', account: null };

describe('T49 — Dashboards (read-only projections, Milestone B2)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t49-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = createRealSqliteDb(dbPath);

    const now = new Date().toISOString();
    // Two tasks in different states with different budget spend.
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, plan_rounds, verify_fixes, cycles, attempts, recover_attempts, created_at, updated_at)
       VALUES ('t-a','Task A','queued','w-a',1,2,0,3,0,?,?)`, now, now
    );
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, plan_rounds, verify_fixes, cycles, attempts, recover_attempts, created_at, updated_at)
       VALUES ('t-b','Task B','verifying','w-b',0,0,1,1,2,?,?)`, now, now
    );
    // Verify runs: one pass, one fail.
    db.run(
      `INSERT INTO bureau_verify_runs (id, task_id, exit_code, timed_out, duration_ms, verify_fixes_before, started_at, finished_at, actor_role, provider, model, account)
       VALUES ('vr-1','t-a',0,0,10,0,?,?,'foreman','deterministic','core',NULL)`, now, now
    );
    db.run(
      `INSERT INTO bureau_verify_runs (id, task_id, exit_code, timed_out, duration_ms, verify_fixes_before, started_at, finished_at, actor_role, provider, model, account)
       VALUES ('vr-2','t-a',1,0,10,0,?,?,'foreman','deterministic','core',NULL)`, now, now
    );
    journal(db, { kind: 'guardrail', attribution: SYS, taskId: 't-b', detail: { action: 'test_refusal' } });
    journal(db, { kind: 'system', attribution: SYS, taskId: 't-a', detail: { action: 'noop' } });
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. projections return correct aggregates', () => {
    const pops = statePopulations(db);
    expect(pops.find(p => p.state === 'queued')?.count).toBe(1);
    expect(pops.find(p => p.state === 'verifying')?.count).toBe(1);

    const spend = budgetSpend(db);
    // t-a has the larger total budget spend (1+2+0+3+0=6 vs 0+0+1+1+2=4) so it sorts first.
    expect(spend[0].task_id).toBe('t-a');
    expect(spend.find(t => t.task_id === 't-b')?.recover_attempts).toBe(2);

    const vfr = verifyFailureRate(db);
    expect(vfr.total_runs).toBe(2);
    expect(vfr.failures).toBe(1);
    expect(vfr.failure_rate).toBeCloseTo(0.5, 5);

    expect(guardrailCount(db)).toBe(1);
  });

  it('2. Read-Only Proof: a full dashboard render mutates zero rows', () => {
    const countAll = () => ({
      tasks: db.all(`SELECT * FROM bureau_tasks ORDER BY id`),
      journal: db.all(`SELECT * FROM bureau_journal ORDER BY id`),
      verify: db.all(`SELECT * FROM bureau_verify_runs ORDER BY id`),
      jobs: db.all(`SELECT * FROM bureau_jobs ORDER BY id`)
    });

    const before = countAll();
    // Render everything the CLI renders.
    dashboardSnapshot(db);
    dashboardSnapshot(db);
    const after = countAll();

    expect(after.tasks).toEqual(before.tasks);
    expect(after.journal).toEqual(before.journal);
    expect(after.verify).toEqual(before.verify);
    expect(after.jobs).toEqual(before.jobs);
  });

  it('3. verifyFailureRate is 0 (not NaN) when there are no runs', () => {
    db.run(`DELETE FROM bureau_verify_runs`);
    const vfr = verifyFailureRate(db);
    expect(vfr.total_runs).toBe(0);
    expect(vfr.failure_rate).toBe(0);
  });
});
