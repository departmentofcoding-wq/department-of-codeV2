import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AttributionTuple, BureauJobRow, BureauTaskRow } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { rearmTask, transition } from '../../engine/state/machine.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';

describe('T25: Exit Sentence Send-Back Loop & Re-arm Integration Test', () => {
  it('demonstrates the full exit sentence: fail -> send-back -> fail -> send-back -> blocked -> human re-arm -> success', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t25-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = createRealSqliteDb(dbPath);
    const provider = new FakeWorkspaceProvider();
    setWorkspaceProvider(provider);

    // Spy on notifyOperator output by capturing console logs
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string, ...args: any[]) => {
      logs.push(msg);
      originalLog(msg, ...args);
    };

    const now = new Date().toISOString();
    const taskId = 't25-exit-sentence-task';

    // Verify fixes ceiling default is 2
    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (
          id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', 0, 1, ?, ?, ?)`,
        taskId,
        'T25 Exit Sentence Task',
        'Intent',
        'Spec',
        'Acceptance',
        'node -e "process.exit(1);"',
        'uuid-t25',
        now,
        now
      );
    });

    await provider.prepare(db, taskId);

    try {
      // --- Run 1: Failure 1 ---
      const job1 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
      await executeVerifyRunJob({ db, job: job1, payload: { taskId }, signal: new AbortController().signal });

      let taskAfter1 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfter1?.state).toBe('claimed');
      expect(taskAfter1?.verify_fixes).toBe(1);

      // Verify failure enqueued junior.dispatch fix round (N1a)
      const queuedJobs1 = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch' AND state = 'pending'", taskId);
      expect(queuedJobs1.length).toBeGreaterThanOrEqual(1);

      // --- Run 2: Failure 2 ---
      const job2 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
      await executeVerifyRunJob({ db, job: job2, payload: { taskId }, signal: new AbortController().signal });

      let taskAfter2 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfter2?.state).toBe('claimed');
      expect(taskAfter2?.verify_fixes).toBe(2);

      const queuedJobs2 = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch' AND state = 'pending'", taskId);
      expect(queuedJobs2.length).toBeGreaterThanOrEqual(2);

      // Assert send-back seam checkpoints were recorded on provider
      const sendbackCheckpoints = provider.checkpoints.filter((c) => c.note === 'verify-failure-sendback');
      expect(sendbackCheckpoints.length).toBe(2);

      // --- Run 3: Failure 3 (Ceiling reached: verify_fixes=2 >= ceiling=2) ---
      const job3 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
      await executeVerifyRunJob({ db, job: job3, payload: { taskId }, signal: new AbortController().signal });

      let taskAfter3 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfter3?.state).toBe('blocked');
      expect(taskAfter3?.verify_fixes).toBe(2);

      // Assert operator was notified with targetId === taskId
      const notifyLogs = logs.filter((l) => l.includes('operator_notified'));
      expect(notifyLogs.some((l) => l.includes(taskId) && l.includes('verify_fixes ceiling reached'))).toBe(true);

      // Assert guardrail journal span
      const guardrailSpans = db.all<{ kind: string; detail: string }>(
        "SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'",
        taskId
      );
      expect(guardrailSpans.length).toBeGreaterThanOrEqual(1);

      // --- Attempt illegal state transition blocked -> claimed with non-human role fails ---
      expect(() => {
        transition(db, taskId, 'claimed', { actor_role: 'verifier', provider: 'deterministic', model: 'core', account: null });
      }).toThrow();

      // --- Human Operator Re-arm & Scripted Fix ---
      // 1. Scripted fix: update verify_cmd to passing command
      db.run('UPDATE bureau_tasks SET verify_cmd = ? WHERE id = ?', 'node -e "process.exit(0);"', taskId);

      // 2. Operator re-arms: blocked -> claimed with human-operator role via rearmTask single-writer
      const humanAttr: AttributionTuple = { actor_role: 'human-operator', provider: 'deterministic', model: 'core', account: 'operator' };
      rearmTask(db, taskId, humanAttr);

      let taskRearmed = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskRearmed?.state).toBe('claimed');
      expect(taskRearmed?.verify_fixes).toBe(0);

      // --- Run 4: Execute auto-enqueued verify.run job created by rearmTask ---
      const queuedJobsRearmed = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
      expect(queuedJobsRearmed.length).toBeGreaterThanOrEqual(1);
      const job4 = queuedJobsRearmed[0];

      await executeVerifyRunJob({ db, job: job4, payload: { taskId }, signal: new AbortController().signal });

      let taskFinal = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskFinal?.state).toBe('needs-review');
      expect(taskFinal?.verifier_exit_code).toBe(0);
    } finally {
      console.log = originalLog;
      setWorkspaceProvider(null);
      provider.cleanup();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
