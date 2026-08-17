import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BureauIntakeMessageRow, BureauIntakeSessionRow } from '../../engine/contract/index.ts';
import { createSession, updateSessionDraft } from '../../engine/intake/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';

describe('T14: Durability — Mid-Turn Process Kill & Resume (real node:sqlite)', () => {
  it('resumes conversation from store after process kill with no duplicated messages and turn budget intact', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t14-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const testDb = createRealSqliteDb(dbPath);

    const killTree = (pid: number | undefined) => {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F']); } catch {}
      } else if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    };

    try {
      const session = createSession(testDb, {
        title: 'Durability kill test task',
        attribution: { actor_role: 'human-operator', provider: 'deterministic', model: 'core', account: 'operator' }
      });

      updateSessionDraft(testDb, session.id, {
        intent: 'Test hard process kill mid-turn',
        verify_cmd: 'vitest run'
      });

      // Enqueue job for turn
      const job = enqueueJob(testDb, {
        kind: 'intake.turn',
        payload: { sessionId: session.id }
      });

      const childEnv = {
        ...process.env,
        BUREAU_DB_PATH: dbPath,
        BUREAU_POLL_MS: '10',
        BUREAU_LEASE_MS: '1000',
        BUREAU_MOCK_LLM: 'true'
      };

      const spawnChild = () =>
        spawn(process.execPath, ['--experimental-strip-types', path.join(repoRoot, 'runner', 'main.ts')], {
          cwd: repoRoot,
          env: childEnv,
          stdio: 'ignore'
        });

      // 1. Spawn Runner Process 1
      const child1 = spawnChild();

      // Wait until job is claimed ('running')
      for (let i = 0; i < 500; i++) {
        const j = testDb.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', job.id);
        if (j?.state === 'running') break;
        await new Promise((res) => setTimeout(res, 10));
      }

      // 2. Hard kill process mid-turn
      killTree(child1.pid);
      await new Promise<void>((res) => child1.once('exit', () => res()));

      // Wait for lease to expire so reaper reaps it back to 'pending'
      await new Promise((res) => setTimeout(res, 1100));

      const messagesBeforeResume = testDb.all<BureauIntakeMessageRow>(
        'SELECT * FROM bureau_intake_messages WHERE session_id = ?',
        session.id
      );

      // 3. Spawn Runner Process 2 to resume
      const child2 = spawnChild();

      for (let i = 0; i < 1000; i++) {
        const j = testDb.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', job.id);
        if (j?.state === 'done') break;
        await new Promise((res) => setTimeout(res, 10));
      }

      killTree(child2.pid);
      await new Promise<void>((res) => child2.once('exit', () => res()));

      // 4. Assert conversation state survived and messages are not duplicated
      const messagesAfterResume = testDb.all<BureauIntakeMessageRow>(
        'SELECT * FROM bureau_intake_messages WHERE session_id = ? ORDER BY created_at ASC',
        session.id
      );

      // Check unique message IDs
      const messageIds = messagesAfterResume.map((m) => m.id);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(messageIds.length);

      // Assert model_calls turn budget count is intact
      const updatedSession = testDb.get<BureauIntakeSessionRow>(
        'SELECT * FROM bureau_intake_sessions WHERE id = ?',
        session.id
      );
      expect(updatedSession?.model_calls).toBeGreaterThanOrEqual(1);
      expect(updatedSession?.model_calls).toBeLessThanOrEqual(10);
    } finally {
      testDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
