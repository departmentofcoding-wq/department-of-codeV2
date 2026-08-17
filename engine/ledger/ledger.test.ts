import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDbConnection, closeDatabase } from '../db/index.ts';
import { journal } from '../journal/writer.ts';
import { getModelAttributionRollups, getWorkSessionCostLines } from './rollups.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('A4: Attribution Ledger', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-ledger-'));
    dbPath = path.join(tempDir, 'test.db');
    const db = openDbConnection(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('T3: attribution exactness — rollups match fixture truth to the token', () => {
    const db = openDbConnection(dbPath);
    const now = new Date().toISOString();

    db.prepare("INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES ('task-1', 'Task 1', 'work-100', ?, ?)").run(now, now);
    db.prepare("INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES ('task-2', 'Task 2', 'work-100', ?, ?)").run(now, now);

    db.prepare("INSERT INTO bureau_jobs (id, kind, task_id, created_at) VALUES ('job-1', 'demo.sleep', 'task-1', ?)").run(now);
    db.prepare("INSERT INTO bureau_jobs (id, kind, task_id, created_at) VALUES ('job-2', 'demo.sleep', 'task-1', ?)").run(now);
    db.prepare("INSERT INTO bureau_jobs (id, kind, task_id, created_at) VALUES ('job-3', 'demo.sleep', 'task-2', ?)").run(now);

    // Actor 1: Senior Engineer GLM-5.2
    journal(db, {
      kind: 'llm',
      attribution: { actor_role: 'senior-engineer', provider: 'zai', model: 'glm-5.2', account: 'zcode' },
      taskId: 'task-1',
      workUuid: 'work-100',
      workTitle: 'Feature Implementation',
      jobId: 'job-1',
      tokensIn: 500,
      tokensOut: 150,
      costUsd: 0.005,
      latencyMs: 1200
    });

    journal(db, {
      kind: 'llm',
      attribution: { actor_role: 'senior-engineer', provider: 'zai', model: 'glm-5.2', account: 'zcode' },
      taskId: 'task-1',
      workUuid: 'work-100',
      workTitle: 'Feature Implementation',
      jobId: 'job-2',
      tokensIn: 300,
      tokensOut: 100,
      costUsd: 0.003,
      latencyMs: 800
    });

    // Actor 2: Junior Engineer Antigravity (Free Tier)
    journal(db, {
      kind: 'llm',
      attribution: { actor_role: 'junior-engineer', provider: 'antigravity', model: 'gemini-3.6-flash', account: null },
      taskId: 'task-2',
      workUuid: 'work-100',
      workTitle: 'Feature Implementation',
      jobId: 'job-3',
      tokensIn: 1000,
      tokensOut: 400,
      costUsd: null, // unpriced model stays NULL in journal, treated as 0 in cost sum
      latencyMs: 500
    });

    const rollups = getModelAttributionRollups(db);
    expect(rollups).toHaveLength(2);

    const glmRollup = rollups.find(r => r.model === 'glm-5.2')!;
    expect(glmRollup).toBeDefined();
    expect(glmRollup.acts).toBe(2);
    expect(glmRollup.tasks_touched).toBe(1);
    expect(glmRollup.jobs_run).toBe(2);
    expect(glmRollup.tokens_in).toBe(800);
    expect(glmRollup.tokens_out).toBe(250);
    expect(glmRollup.cost_usd).toBeCloseTo(0.008, 5);
    expect(glmRollup.cost_recorded).toBe(true);
    expect(glmRollup.avg_latency_ms).toBe(1000);

    const agRollup = rollups.find(r => r.model === 'gemini-3.6-flash')!;
    expect(agRollup).toBeDefined();
    expect(agRollup.acts).toBe(1);
    expect(agRollup.tasks_touched).toBe(1);
    expect(agRollup.jobs_run).toBe(1);
    expect(agRollup.tokens_in).toBe(1000);
    expect(agRollup.tokens_out).toBe(400);
    expect(agRollup.cost_usd).toBe(0);
    expect(agRollup.cost_recorded).toBe(false); // unpriced model: "not recorded", not "$0"
    expect(agRollup.avg_latency_ms).toBe(500);

    // Work session cost line
    const workLines = getWorkSessionCostLines(db);
    expect(workLines).toHaveLength(1);
    expect(workLines[0].work_uuid).toBe('work-100');
    expect(workLines[0].acts).toBe(3);
    expect(workLines[0].tokens_in).toBe(1800);
    expect(workLines[0].tokens_out).toBe(650);
    expect(workLines[0].total_cost_usd).toBeCloseTo(0.008, 5);
    expect(workLines[0].cost_recorded).toBe(true);
  });
});
