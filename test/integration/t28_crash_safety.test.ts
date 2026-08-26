import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BureauTaskRow, BureauVerifyRunRow } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { killTree } from '../../engine/verify/tree_kill.ts';
import { Runner } from '../../runner/main.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';
import { pollUntil } from '../helpers/wait.ts';

describe('T28: Crash Safety Mid-Verify Integration Test', () => {
  it(
    'hard process kill mid-child leaves zero partial state; fresh runner resumes cleanly from verifying state with exactly one run row and state consistent',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t28-'));
      const dbPath = path.join(tmpDir, 'test.db');
      const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
      const db = createRealSqliteDb(dbPath);
      const provider = new FakeWorkspaceProvider();
      setWorkspaceProvider(provider);

      const now = new Date().toISOString();
      const taskId = 't28-crash-task-id';

      db.execTransaction(() => {
        db.run(
          `INSERT INTO bureau_tasks (
            id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', 0, 1, ?, ?, ?)`,
          taskId,
          'T28 Crash Task',
          'Intent',
          'Spec',
          'Acceptance',
          'node slow_pass.js',
          'uuid-t28',
          now,
          now
        );
      });

      const wsHandle = await provider.prepare(db, taskId);

      // Write helper script inside workspace handle path (sleeps 400ms)
      const verifyScriptPath = path.join(wsHandle.path, 'slow_pass.js');
      fs.writeFileSync(verifyScriptPath, 'setTimeout(() => { process.exit(0); }, 400);');

      const job = enqueueJob(db, {
        kind: 'verify.run',
        task_id: taskId,
        payload: { taskId }
      });

      // Write child runner process entrypoint with file:// URL imports
      const runnerScriptPath = path.join(tmpDir, 'runner_proc.ts');
      const dbUrl = pathToFileURL(path.join(repoRoot, 'engine', 'db', 'index.ts')).href;
      const seamUrl = pathToFileURL(path.join(repoRoot, 'engine', 'contract', 'workspace-seam.ts')).href;
      const fakeUrl = pathToFileURL(path.join(repoRoot, 'test', 'helpers', 'fake_workspace_provider.ts')).href;
      const runnerUrl = pathToFileURL(path.join(repoRoot, 'runner', 'main.ts')).href;

      const scriptContent = `
import { openDbConnection } from '${dbUrl}';
import { setWorkspaceProvider } from '${seamUrl}';
import { FakeWorkspaceProvider } from '${fakeUrl}';
import { Runner } from '${runnerUrl}';

const provider = new FakeWorkspaceProvider('${provider['baseDir'].replace(/\\/g, '/')}');
setWorkspaceProvider(provider);
const db = openDbConnection('${dbPath.replace(/\\/g, '/')}');
const runner = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 300, BUREAU_HEARTBEAT_MS: 100 });
runner.start();
`;
      fs.writeFileSync(runnerScriptPath, scriptContent);

      let runnerStdout = '';
      let runnerStderr = '';

      // 1. Spawn runner process using native Node runner entrypoint with file:// imports
      const runnerProc = spawn(process.execPath, ['--experimental-strip-types', runnerScriptPath], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (runnerProc.stdout) {
        runnerProc.stdout.on('data', (d) => { runnerStdout += d.toString(); });
      }
      if (runnerProc.stderr) {
        runnerProc.stderr.on('data', (d) => { runnerStderr += d.toString(); });
      }

      // Wait (deterministically) for the child runner to move the task to
      // 'verifying'. pollUntil returns the instant the row shows it and only
      // fails after a generous deadline, so a slow-but-correct run under load
      // isn't scored as a failure (the property fileParallelism:false stood in for).
      let stateWasVerifying = false;
      try {
        await pollUntil(
          () => db.get<BureauTaskRow>('SELECT state FROM bureau_tasks WHERE id = ?', taskId)?.state === 'verifying' || undefined,
          { timeoutMs: 15000, intervalMs: 25, label: 't28 task reaches verifying' }
        );
        stateWasVerifying = true;
      } catch {
        console.error('T28 runnerProc failed to reach verifying. Stdout:', runnerStdout, 'Stderr:', runnerStderr);
      }
      expect(stateWasVerifying).toBe(true);

      // Hard kill the runner process mid-child execution
      killTree(runnerProc.pid);
      await new Promise<void>((res) => runnerProc.once('exit', () => res()));

      // Verify zero verify run rows written before restart
      const runsBefore = db.all<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
      expect(runsBefore.length).toBe(0);

      // 2. Start a fresh runner in-process to reap lease and resume execution
      const freshRunner = new Runner(db, { BUREAU_POLL_MS: 10, BUREAU_LEASE_MS: 5000, BUREAU_HEARTBEAT_MS: 200 });
      freshRunner.start();

      // Await completion of the resumed job (deterministic condition-wait).
      let finalTask: BureauTaskRow | undefined;
      try {
        finalTask = await pollUntil(() => {
          const t = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
          return t?.state === 'needs-review' ? t : null;
        }, { timeoutMs: 15000, intervalMs: 50, label: 't28 resume to needs-review' });
      } catch {
        finalTask = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      }

      await freshRunner.stop();

      // Assert post-restart end state explicitly
      expect(finalTask?.state).toBe('needs-review');
      expect(finalTask?.verifier_exit_code).toBe(0);

      // Assert exactly one verify run row was written
      const runsAfter = db.all<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
      expect(runsAfter.length).toBe(1);
      expect(runsAfter[0].exit_code).toBe(0);

      try {
        setWorkspaceProvider(null);
        provider.cleanup();
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
    40000
  );
});
