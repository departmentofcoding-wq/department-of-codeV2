import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BureauVerifyRunRow } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';

describe('T27: Output Hygiene Integration Test', () => {
  it('guarantees secrets printed by a verify command are redacted and appear nowhere in bureau_verify_runs or bureau_journal', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t27-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = createRealSqliteDb(dbPath);
    const provider = new FakeWorkspaceProvider();
    setWorkspaceProvider(provider);

    const now = new Date().toISOString();
    const taskId = 't27-secret-leak-task';
    const secretValue = 'AIzaSyA1234567890SecretKeyHere';

    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (
          id, title, intent, spec, acceptance, verify_cmd, state, priority, work_uuid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
        taskId,
        'T27 Secret Leak Task',
        'Intent',
        'Spec',
        'Acceptance',
        'node print_secret.js',
        'uuid-t27',
        now,
        now
      );
    });

    const wsHandle = await provider.prepare(db, taskId);

    // Write helper script inside workspace handle path
    const scriptPath = path.join(wsHandle.path, 'print_secret.js');
    fs.writeFileSync(scriptPath, `console.log("GOOGLE_API_KEY=${secretValue}"); process.exit(0);`);

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

      const runRow = db.get<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
      expect(runRow).toBeDefined();

      // Check run row stdout/stderr tails
      expect(runRow?.stdout_tail).not.toContain(secretValue);
      expect(runRow?.stdout_tail).toContain('[REDACTED]');

      // Check complete database dump to ensure raw secret string appears nowhere in SQLite
      const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
      for (const { name } of tables) {
        if (name.startsWith('sqlite_')) continue;
        const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${name}`);
        const dump = JSON.stringify(rows);
        expect(dump).not.toContain(secretValue);
      }
    } finally {
      setWorkspaceProvider(null);
      provider.cleanup();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
