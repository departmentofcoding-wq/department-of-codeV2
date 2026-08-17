import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerifier } from '../../engine/verify/verifier.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';

describe('T23: Timeout Tree-Kill Integration Test', () => {
  it('tree-kills an over-timeout command and records timed_out=1 with null exit code', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t23-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = createRealSqliteDb(dbPath);

    const now = new Date().toISOString();
    const taskId = 't23-task-id';

    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (
          id, title, intent, spec, acceptance, verify_cmd, state, priority, work_uuid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
        taskId,
        'T23 Task',
        'Test timeout',
        'Spec',
        'Acceptance',
        'node -e "setTimeout(() => {}, 60000);"',
        'uuid-t23',
        now,
        now
      );
    });

    try {
      const outcome = await runVerifier(db, taskId, tmpDir, { timeoutMs: 300 });

      expect(outcome.timedOut).toBe(true);
      expect(outcome.exitCode).toBeNull();
      expect(outcome.durationMs).toBeGreaterThanOrEqual(250);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
