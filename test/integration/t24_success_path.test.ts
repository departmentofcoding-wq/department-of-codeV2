import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BureauTaskRow, BureauVerifyRunRow } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';

describe('T24: Success Path Integration Test', () => {
  it('runs verify.run to completion, transitions to needs-review, sets verifier_exit_code=0, and attributes run row & journal', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t24-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = createRealSqliteDb(dbPath);
    const provider = new FakeWorkspaceProvider();
    setWorkspaceProvider(provider);

    const now = new Date().toISOString();
    const taskId = 't24-task-id';

    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (
          id, title, intent, spec, acceptance, verify_cmd, state, priority, work_uuid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
        taskId,
        'T24 Success Task',
        'Intent',
        'Spec',
        'Acceptance',
        'node -e "console.log(\'all tests passed\'); process.exit(0);"',
        'uuid-t24',
        now,
        now
      );
    });

    await provider.prepare(db, taskId);

    const job = enqueueJob(db, {
      kind: 'verify.run',
      task_id: taskId,
      payload: { taskId }
    });

    try {
      await executeVerifyRunJob({
        db,
        job,
        payload: { taskId },
        signal: new AbortController().signal
      });

      const updatedTask = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(updatedTask?.state).toBe('needs-review');
      expect(updatedTask?.verifier_exit_code).toBe(0);

      const runRow = db.get<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
      expect(runRow).toBeDefined();
      expect(runRow?.exit_code).toBe(0);
      expect(runRow?.timed_out).toBe(0);
      expect(runRow?.actor_role).toBe('verifier');
      expect(runRow?.stdout_tail).toContain('all tests passed');

      // Check journal span
      const spans = db.all<{ kind: string; actor_role: string }>('SELECT * FROM bureau_journal WHERE task_id = ?', taskId);
      expect(spans.some((s) => s.kind === 'tool' && s.actor_role === 'verifier')).toBe(true);
      expect(spans.some((s) => s.kind === 'transition' && s.actor_role === 'verifier')).toBe(true);
    } finally {
      setWorkspaceProvider(null);
      provider.cleanup();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
