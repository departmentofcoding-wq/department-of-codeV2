import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauTaskRow, DbConnection } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';
import { handleVerifyOutcome } from '../../engine/verify/loop.ts';

describe('tc_verify_fix_dispatch_flow: End-to-End Verify Fix Dispatch & Re-Review Flow', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection & { close: () => void };
  let provider: FakeWorkspaceProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n1a-flow-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = createRealSqliteDb(dbPath);
    provider = new FakeWorkspaceProvider();
    setWorkspaceProvider(provider);
  });

  afterEach(() => {
    setWorkspaceProvider(null);
    setAntigravityDriverOverride(null);
    setSeniorDriverOverride(null);
    provider.cleanup();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      fs.rmSync(path.join(process.cwd(), 'docs', 'junior-artifacts', 'task-verify-fix-flow-1'), {
        recursive: true,
        force: true
      });
    } catch {}
  });

  it('runs complete lifecycle: verify fails -> pre-tx checkpoint -> junior.dispatch (chainWorkReview) -> work.cycle -> worktree.prepare/verify -> pass -> needs-review', async () => {
    const taskId = 'task-verify-fix-flow-1';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'Verify Fix Flow Task', 'Intent', 'Spec', 'Acceptance', 'node -e "process.exit(1);"', 'claimed', 0, 1, 'uuid-vflow-1', ?, ?)`,
      taskId,
      now,
      now
    );

    await provider.prepare(db, taskId);

    // 1. Initial failing verify.run
    const verifyJob1 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
    await executeVerifyRunJob({ db, job: verifyJob1, payload: { taskId }, signal: new AbortController().signal });

    // Assert pre-tx checkpoint was recorded on provider
    const sendbackCheckpoints = provider.checkpoints.filter((c) => c.note === 'verify-failure-sendback');
    expect(sendbackCheckpoints.length).toBe(1);

    // Assert task state is claimed and fixes incremented
    const taskAfterFail = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(taskAfterFail?.state).toBe('claimed');
    expect(taskAfterFail?.verify_fixes).toBe(1);

    // Assert junior.dispatch was enqueued with chainWorkReview: true
    const juniorJobs = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch' AND state = 'pending'", taskId);
    expect(juniorJobs.length).toBe(1);

    const juniorJob = juniorJobs[0];
    const payload = JSON.parse(juniorJob.payload);
    expect(payload.chainWorkReview).toBe(true);
    expect(payload.freshConversation).toBe(false);

    // 2. Execute junior.dispatch with mock driver
    const walkthroughOutput = 'Walkthrough\nFixed the bug that caused exit code 1.\nTests pass.';
    setAntigravityDriverOverride({
      runCommand: async (_prompt: string, runOpts: any) => {
        return {
          transcript: 'Junior fixed the code in worktree.',
          walkthrough: walkthroughOutput,
          junior: runOpts?.junior ?? 'A',
          launched: false
        };
      }
    });

    await handleJuniorDispatch({ db, job: juniorJob, payload, signal: new AbortController().signal });

    // Assert dispatch completed and work.cycle job was chained
    const workCycleJobs = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'work.cycle' AND state = 'pending'", taskId);
    expect(workCycleJobs.length).toBe(1);

    // 3. Senior reviews the walkthrough and approves
    setSeniorDriverOverride({
      review: async () => ({
        senior: 'claude',
        verdict: 'approve',
        feedback: 'Fix looks complete and correct.',
        raw: 'VERDICT: APPROVE',
        model: 'claude-3-5-sonnet'
      })
    });

    const reviewRes = await runWorkReviewCycle(db, { taskId, seniorId: 'claude', walkthrough: walkthroughOutput });
    expect(reviewRes.outcome).toBe('approved');

    // Assert worktree.prepare was enqueued for re-verification
    const prepJobs = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'worktree.prepare' AND state = 'pending'", taskId);
    expect(prepJobs.length).toBe(1);

    // 4. Update verify_cmd to pass and execute passing verify.run
    db.run('UPDATE bureau_tasks SET verify_cmd = ? WHERE id = ?', 'node -e "process.exit(0);"', taskId);

    const verifyJob2 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
    await executeVerifyRunJob({ db, job: verifyJob2, payload: { taskId }, signal: new AbortController().signal });

    // Task advances to needs-review with exit_code 0
    const taskFinal = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(taskFinal?.state).toBe('needs-review');
    expect(taskFinal?.verifier_exit_code).toBe(0);
  });

  it('triggers stale approval re-review if junior fix moved the tip past the reviewed commit', () => {
    const taskId = 'task-stale-fix';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, verify_fixes, priority, work_uuid, created_at, updated_at)
       VALUES (?, 'Task Stale Guard', 'verifying', 1, 1, 'uuid-stale-1', ?, ?)`,
      taskId,
      now,
      now
    );

    // Record standing approval at commit C1
    db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES ('rev-1', ?, 'uuid-stale-1', 'walkthrough', 1, 'approved', 'Looks good', 'commit-c1', 'senior-engineer', 'claude', 'sonnet', NULL, ?)`,
      taskId,
      now
    );

    // Verify passes, but tip is commit-c2 (moved by junior fix)
    const passingOutcome = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 200,
      stdoutTail: 'ok',
      stderrTail: ''
    };

    const res = handleVerifyOutcome(db, taskId, passingOutcome, undefined, { tip: 'commit-c2' });
    expect(res.isSuccess).toBe(false);
    expect(res.isSendback).toBe(false);

    // Task remains claimed, work.cycle enqueued for re-review
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    expect(task?.state).toBe('claimed');

    const reviewJobs = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'work.cycle'", taskId);
    expect(reviewJobs.length).toBe(1);
  });
});
