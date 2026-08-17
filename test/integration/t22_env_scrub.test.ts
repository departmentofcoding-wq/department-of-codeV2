import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVerifier } from '../../engine/verify/verifier.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';

describe('T22: Environment Scrubbing Integration Test', () => {
  it('guarantees parent API keys and secrets are absent from the verify child process environment', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t22-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = createRealSqliteDb(dbPath);

    // Workspace directory
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    // Helper script that dumps keys of interest to keep output small (<4KB)
    const scriptPath = path.join(wsDir, 'dump_env.js');
    const helperCode = `
      const targetKeys = ['GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BUREAU_SECRET', 'PATH', 'SystemRoot', 'SYSTEMROOT'];
      const filtered = {};
      for (const k of Object.keys(process.env)) {
        if (targetKeys.includes(k) || k.includes('API') || k.includes('SECRET')) {
          filtered[k] = process.env[k];
        }
      }
      process.stdout.write("ENV_START_" + JSON.stringify(filtered) + "_ENV_END\\n");
    `;
    fs.writeFileSync(scriptPath, helperCode);

    // Set parent environment variables
    process.env.GOOGLE_API_KEY = 'secret-google-key-12345';
    process.env.ANTHROPIC_API_KEY = 'secret-anthropic-key-67890';
    process.env.OPENAI_API_KEY = 'secret-openai-key-abcde';
    process.env.BUREAU_SECRET = 'secret-bureau-val';

    const now = new Date().toISOString();
    const taskId = 't22-task-id';

    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (
          id, title, intent, spec, acceptance, verify_cmd, state, priority, work_uuid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, ?)`,
        taskId,
        'T22 Task',
        'Test env scrub',
        'Spec',
        'Acceptance',
        'node dump_env.js',
        'uuid-t22',
        now,
        now
      );
    });

    try {
      const outcome = await runVerifier(db, taskId, wsDir);

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdoutTail).toBeDefined();

      const startIdx = outcome.stdoutTail.indexOf('ENV_START_');
      const endIdx = outcome.stdoutTail.indexOf('_ENV_END');
      expect(startIdx).not.toBe(-1);
      expect(endIdx).not.toBe(-1);

      const jsonStr = outcome.stdoutTail.slice(startIdx + 'ENV_START_'.length, endIdx);
      const childEnv = JSON.parse(jsonStr);

      expect(childEnv.GOOGLE_API_KEY).toBeUndefined();
      expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(childEnv.OPENAI_API_KEY).toBeUndefined();
      expect(childEnv.BUREAU_SECRET).toBeUndefined();

      // Ensure standard system variables remain intact for node/shell execution
      if (process.platform === 'win32') {
        expect(childEnv.SystemRoot || childEnv.SYSTEMROOT || childEnv.Path || childEnv.PATH).toBeDefined();
      } else {
        expect(childEnv.PATH).toBeDefined();
      }
    } finally {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.BUREAU_SECRET;
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
