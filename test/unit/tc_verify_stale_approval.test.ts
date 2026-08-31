import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple, BureauTaskRow } from '../../engine/contract/index.ts';
import type { VerifyRunResult } from '../../engine/verify/verifier.ts';
import { handleVerifyOutcome } from '../../engine/verify/loop.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';

/**
 * N1 / defect 2: a passing verify must NOT reach the delivery gate on a STALE
 * approval. When a `verify-failure-sendback` checkpoint has moved the branch tip
 * past the commit the senior approved, `handleVerifyOutcome`'s success path must
 * re-enter senior work review (transition back to `claimed` + enqueue
 * `work.cycle`) instead of landing at `needs-review` with a stale verdict — the
 * b55e2fda scar where `pr.create` then refused on `reviewed_commit != tip` and
 * the task stranded.
 */
describe('N1: verify success guards against a stale standing approval', () => {
  let tmpDir: string;
  let db: ReturnType<typeof createRealSqliteDb>;
  const attr: AttributionTuple = { actor_role: 'verifier', provider: 'deterministic', model: 'core', account: null };
  const PASS: VerifyRunResult = {
    exitCode: 0, signal: null, timedOut: false, durationMs: 5,
    stdoutTail: '', stderrTail: '', stages: [], passBefore: null, passAfter: null
  } as VerifyRunResult;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n1-'));
    db = createRealSqliteDb(path.join(tmpDir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedTask(taskId: string, state = 'verifying') {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'N1 task', 'i', 's', 'a', 'node -e "0"', ?, 0, 1, 'uuid-n1', ?, ?)`,
      taskId, state, now, now
    );
  }

  function seedApproval(taskId: string, reviewedCommit: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
       VALUES (?, ?, 'uuid-n1', 'walkthrough', 1, 'approved', ?, 'senior-engineer', 'claude', 'opus', ?)`,
      `wr-${Math.random()}`, taskId, reviewedCommit, now
    );
  }

  function state(taskId: string): string {
    return db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!.state;
  }
  function workCycleJobs(taskId: string): number {
    return db.all(`SELECT id FROM bureau_jobs WHERE task_id = ? AND kind = 'work.cycle'`, taskId).length;
  }

  it('stale approval (reviewed_commit != tip): re-enters review instead of needs-review', () => {
    const taskId = 'n1-stale';
    seedTask(taskId);
    seedApproval(taskId, 'commitC1');

    const res = handleVerifyOutcome(db, taskId, PASS, attr, { tip: 'commitC2' });

    expect(state(taskId)).toBe('claimed');
    expect(res.isSuccess).toBe(false);
    expect(workCycleJobs(taskId)).toBe(1);
    const guardrails = db.all<{ detail: string }>(
      `SELECT detail FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'`, taskId
    );
    expect(guardrails.some((g) => g.detail.includes('verify_passed_stale_approval'))).toBe(true);
  });

  it('fresh approval (reviewed_commit == tip): reaches needs-review normally', () => {
    const taskId = 'n1-fresh';
    seedTask(taskId);
    seedApproval(taskId, 'commitC2');

    const res = handleVerifyOutcome(db, taskId, PASS, attr, { tip: 'commitC2' });

    expect(state(taskId)).toBe('needs-review');
    expect(res.isSuccess).toBe(true);
    expect(workCycleJobs(taskId)).toBe(0);
  });

  it('no approval row: reaches needs-review (exit-sentence loop / no work review yet)', () => {
    const taskId = 'n1-none';
    seedTask(taskId);

    const res = handleVerifyOutcome(db, taskId, PASS, attr, { tip: 'commitC2' });

    expect(state(taskId)).toBe('needs-review');
    expect(res.isSuccess).toBe(true);
    expect(workCycleJobs(taskId)).toBe(0);
  });

  it('tip unreadable (undefined): guard disabled, reaches needs-review (pre-fix behaviour)', () => {
    const taskId = 'n1-notip';
    seedTask(taskId);
    seedApproval(taskId, 'commitC1');

    const res = handleVerifyOutcome(db, taskId, PASS, attr, {});

    expect(state(taskId)).toBe('needs-review');
    expect(res.isSuccess).toBe(true);
    expect(workCycleJobs(taskId)).toBe(0);
  });

  it('is idempotent: a work.cycle already in flight is not double-enqueued', () => {
    const taskId = 'n1-inflight';
    seedTask(taskId);
    seedApproval(taskId, 'commitC1');
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, created_at)
       VALUES ('pre-existing', 'work.cycle', ?, '{}', 'pending', 0, 1, ?)`,
      taskId, now
    );

    handleVerifyOutcome(db, taskId, PASS, attr, { tip: 'commitC2' });

    expect(state(taskId)).toBe('claimed');
    expect(workCycleJobs(taskId)).toBe(1); // still just the pre-existing one
  });
});
