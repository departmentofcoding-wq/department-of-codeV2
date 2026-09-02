import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { acquireLease, releaseLease } from '../../engine/harness/lease-manager.ts';
import { runPlanReviewCycle } from '../../engine/flow/plan_review_cycle.ts';

/**
 * N11 — plan authoring serializes on the per-junior window lease.
 *
 * Scar (2026-09-01): `junior.dispatch` acquires `window-${junior}` but plan
 * AUTHORING called the driver directly with no lease — two same-junior cycles
 * each cold-launched the IDE (two windows for one junior, the operator-observed
 * RAM waste) and collided on cold-start attach, killing cycles. Authoring now
 * acquires (waiting, bounded) + heartbeats + releases the same lease target a
 * dispatch uses, so same-junior cycles serialize on one window.
 */
describe('N11: plan authoring serializes on the per-junior window lease', () => {
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
  });

  function seedTask(db: any, taskId: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, plan_rounds, created_at, updated_at)
       VALUES (?, 'Serialize authoring', 'two same-junior cycles must not collide', 'spec', 'accept', 'claimed', 'w-${taskId}', 0, ?, ?)`,
      taskId, now, now
    );
  }

  const GOOD_PLAN = [
    'Implementation Plan',
    'Branch: wt/junior-a-serial',
    'Scope: one file.',
    'Tests: t.test.ts asserts behavior; mutation: break it → test fails.',
    'Walkthrough: verify build + suite, then post results.'
  ].join('\n');

  function approveSenior() {
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'test' })
    } as any);
  }

  it('two concurrent SAME-junior plan cycles SERIALIZE — never two authors in one window, both complete', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-n11-a');
    seedTask(db, 'task-n11-b');

    // The fake junior tracks how many authors run CONCURRENTLY inside the window.
    let inFlight = 0;
    let maxInFlight = 0;
    setAntigravityDriverOverride({
      async runCommand() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 350));
        inFlight--;
        return { transcript: GOOD_PLAN, launched: false };
      }
    } as any);
    approveSenior();

    const [r1, r2] = await Promise.all([
      runPlanReviewCycle(db, { taskId: 'task-n11-a', junior: 'A', seniorId: 'claude' }),
      runPlanReviewCycle(db, { taskId: 'task-n11-b', junior: 'A', seniorId: 'claude' })
    ]);

    // Both cycles completed (the second WAITED for the window, then authored).
    expect(r1.outcome).toBe('approved');
    expect(r2.outcome).toBe('approved');

    // The serialization invariant: never more than one author in the window.
    expect(maxInFlight).toBe(1);

    // Both lease rows exist and are released — the window is free again.
    const leases = db.all(`SELECT * FROM bureau_window_leases WHERE window_target = 'window-A'`);
    expect(leases.length).toBe(2);
    expect(leases.every((l: any) => l.status === 'released')).toBe(true);

    // The acquisition is journaled; the second waited for the first.
    const spans = db.all(
      `SELECT detail FROM bureau_journal WHERE detail LIKE '%plan_authoring_window_lease_acquired%'`
    );
    expect(spans.length).toBe(2);
    const waitFlags = spans.map((s: any) => JSON.parse(s.detail).waited).sort();
    expect(waitFlags).toEqual([false, true]);
  });

  it('a junior failure releases the lease — the next same-junior cycle acquires immediately', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-n11-f1');
    seedTask(db, 'task-n11-f2');

    let call = 0;
    setAntigravityDriverOverride({
      async runCommand() {
        call++;
        // A genuine AGENT failure (stall), NOT an infra attach miss — so N12's
        // infra-only retry does not kick in and this stays terminal, which is
        // what exercises the lease-release-on-failure path here.
        if (call === 1) throw new Error('junior stalled: no progress for the stall window');
        return { transcript: GOOD_PLAN, launched: false };
      }
    } as any);
    approveSenior();

    await expect(
      runPlanReviewCycle(db, { taskId: 'task-n11-f1', junior: 'B', seniorId: 'claude' })
    ).rejects.toThrow(/no progress for the stall window/);

    // The lease was released in the failure path: the next cycle acquires
    // IMMEDIATELY (no wait) and completes.
    const t0 = Date.now();
    const res = await runPlanReviewCycle(db, { taskId: 'task-n11-f2', junior: 'B', seniorId: 'claude' });
    expect(res.outcome).toBe('approved');
    expect(Date.now() - t0).toBeLessThan(2000);

    const active = db.get(`SELECT * FROM bureau_window_leases WHERE window_target = 'window-B' AND status = 'active'`);
    expect(active).toBeFalsy();
  });

  it('wait-timeout fails loud when another holder keeps the window past the budget', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-n11-t');

    // An external holder owns the window (e.g. a wedged dispatch lease).
    const holder = acquireLease(db, 'window-A', 'disp-external', {
      actor_role: 'junior-engineer', provider: 'antigravity', model: 'test', account: null
    });

    setAntigravityDriverOverride({
      async runCommand() { throw new Error('must not be reached'); }
    } as any);

    await expect(
      runPlanReviewCycle(db, {
        taskId: 'task-n11-t',
        junior: 'A',
        seniorId: 'claude',
        juniorLeaseWaitMs: 300,
        signal: undefined
      })
    ).rejects.toThrow(/Timed out after 300ms waiting for window lease 'window-A'/);

    // The external holder is untouched; no authoring lease was created.
    const row = db.get(`SELECT status FROM bureau_window_leases WHERE id = ?`, holder.id) as { status: string } | undefined;
    expect(row?.status).toBe('active');
    const spans = db.all(`SELECT detail FROM bureau_journal WHERE detail LIKE '%plan_authoring_window_lease_acquired%'`);
    expect(spans.length).toBe(0);

    releaseLease(db, holder.id);
  });

  it('boot migration drops the dispatch FK from an existing bureau_window_leases table (authoring can hold leases)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n11-mig-'));
    const dbPath = path.join(tmp, 'old.db');
    try {
      // A pre-N11 database: the lease table carries the dispatch FK and rows.
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE bureau_dispatches (id TEXT PRIMARY KEY, task_id TEXT, work_uuid TEXT, actor_role TEXT, provider TEXT, model TEXT, status TEXT, attempts INTEGER, created_at TEXT);
        CREATE TABLE bureau_window_leases (
          id TEXT PRIMARY KEY,
          window_target TEXT NOT NULL,
          dispatch_id TEXT NOT NULL REFERENCES bureau_dispatches(id),
          status TEXT NOT NULL CHECK (status IN ('active','released','expired','reaped')),
          acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          heartbeats INTEGER NOT NULL DEFAULT 0,
          actor_role TEXT NOT NULL, provider TEXT NOT NULL,
          model TEXT NOT NULL, account TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      raw.prepare(`INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
                   VALUES ('disp-old', 't-old', 'w', 'junior-engineer', 'antigravity', 'm', 'completed', 1, ?)`)
        .run(new Date().toISOString());
      raw.prepare(`INSERT INTO bureau_window_leases (id, window_target, dispatch_id, status, acquired_at, expires_at, heartbeats, actor_role, provider, model, account, created_at, updated_at)
                   VALUES ('lease-old', 'window-A', 'disp-old', 'released', ?, ?, 3, 'junior-engineer', 'antigravity', 'm', NULL, ?, ?)`)
        .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      raw.close();

      // Opening applies boot migrations: the table is rebuilt WITHOUT the FK,
      // preserving rows; a NON-dispatch holder (plan authoring) is accepted.
      const db = openDbConnection(dbPath);
      const master = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='bureau_window_leases'`
      ).get() as { sql: string };
      expect(master.sql).not.toContain('REFERENCES bureau_dispatches');

      const preserved = db.prepare(`SELECT * FROM bureau_window_leases WHERE id = 'lease-old'`).get() as any;
      expect(preserved.dispatch_id).toBe('disp-old');
      expect(preserved.heartbeats).toBe(3);

      const lease = acquireLease(db, 'window-A', 'plan.cycle:not-a-dispatch', {
        actor_role: 'junior-engineer', provider: 'antigravity', model: 'test', account: null
      });
      expect(lease.status).toBe('active');
      releaseLease(db, lease.id);
      db.close();
      closeDatabase();

      // Reopening is idempotent (the rebuild is guarded by the live DDL shape).
      const again = openDbConnection(dbPath);
      const master2 = again.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='bureau_window_leases'`
      ).get() as { sql: string };
      expect(master2.sql).not.toContain('REFERENCES bureau_dispatches');
      again.close();
      closeDatabase();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * N12 — bounded auto-retry for plan authoring on an INFRA-class attach miss.
 *
 * A "workbench window did not become available" / cold-start attach miss is an
 * infrastructure failure, not an agent verdict — so plan.cycle (max_attempts:1)
 * retries it a bounded number of times (fresh attach) instead of dying terminally
 * and needing an operator rekick. A genuine AGENT failure (stall net, wall) is
 * NOT matched by the infra classifier and stays terminal on the first miss, so
 * the "failed agent cycles are operator action" rule is unchanged.
 */
describe('N12: bounded infra-class auto-retry for plan authoring', () => {
  afterEach(() => {
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
  });

  function seedTask(db: any, taskId: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, work_uuid, plan_rounds, created_at, updated_at)
       VALUES (?, 'N12 infra retry', 'authoring survives a cold-start attach miss', 'spec', 'accept', 'claimed', 'w-${taskId}', 0, ?, ?)`,
      taskId, now, now
    );
  }
  const GOOD_PLAN = [
    'Implementation Plan',
    'Branch: wt/junior-a-n12',
    'Scope: one file.',
    'Tests: t.test.ts asserts behavior; mutation: break it → test fails.',
    'Walkthrough: verify build + suite, then post results.'
  ].join('\n');
  function approveSenior() {
    setSeniorDriverOverride({
      review: async () => ({ senior: 'claude', verdict: 'approve', feedback: 'ok', raw: 'VERDICT: APPROVE', model: 'test' })
    } as any);
  }
  function setInfraRetries(db: any, n: number) {
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES ('plan:authoring_infra_retries', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(n)
    );
  }

  it('an INFRA attach miss ("workbench window did not become available") is RETRIED, then authoring succeeds', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-n12-a');
    let calls = 0;
    setAntigravityDriverOverride({
      async runCommand() {
        calls++;
        if (calls === 1) throw new Error('Antigravity 2.0 workbench window did not become available in time.');
        return { transcript: GOOD_PLAN, launched: false };
      }
    } as any);
    approveSenior();

    const res = await runPlanReviewCycle(db, { taskId: 'task-n12-a', junior: 'A', seniorId: 'claude' });
    expect(res.outcome).toBe('approved');
    expect(calls).toBe(2); // one infra miss + one success

    // The retry was journaled as an infra-class guardrail (not an agent verdict).
    const spans = db.all(`SELECT detail FROM bureau_journal WHERE detail LIKE '%plan_authoring_infra_retry%'`);
    expect(spans.length).toBe(1);
    expect(JSON.parse((spans[0] as any).detail).stage).toBe('plan-authoring');

    // The single held lease is released after the successful retry.
    const leases = db.all(`SELECT * FROM bureau_window_leases WHERE window_target = 'window-A'`);
    expect(leases.every((l: any) => l.status === 'released')).toBe(true);
  });

  it('a genuine AGENT failure is NOT retried — one attempt, terminal, lease released', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-n12-agent');
    let calls = 0;
    setAntigravityDriverOverride({
      async runCommand() {
        calls++;
        throw new Error('junior did not complete: no progress for the stall window');
      }
    } as any);
    approveSenior();

    await expect(
      runPlanReviewCycle(db, { taskId: 'task-n12-agent', junior: 'A', seniorId: 'claude' })
    ).rejects.toThrow(/no progress for the stall window/);
    expect(calls).toBe(1); // NOT retried — an agent failure stays terminal

    const spans = db.all(`SELECT detail FROM bureau_journal WHERE detail LIKE '%plan_authoring_infra_retry%'`);
    expect(spans.length).toBe(0);
    const active = db.get(`SELECT * FROM bureau_window_leases WHERE window_target = 'window-A' AND status = 'active'`);
    expect(active).toBeFalsy(); // lease still released on the terminal path
  });

  it('infra retries are BOUNDED — exhausting the budget fails terminally', async () => {
    const db = createFakeDb();
    seedTask(db, 'task-n12-exhaust');
    setInfraRetries(db, 2);
    let calls = 0;
    setAntigravityDriverOverride({
      async runCommand() {
        calls++;
        throw new Error('workbench window did not become available in time.');
      }
    } as any);
    approveSenior();

    await expect(
      runPlanReviewCycle(db, { taskId: 'task-n12-exhaust', junior: 'A', seniorId: 'claude' })
    ).rejects.toThrow(/workbench window did not become available/);
    expect(calls).toBe(3); // initial attempt + 2 bounded retries, then terminal

    const active = db.get(`SELECT * FROM bureau_window_leases WHERE window_target = 'window-A' AND status = 'active'`);
    expect(active).toBeFalsy();
  });
});
