import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AttributionTuple, BureauJobRow, BureauTaskRow, BureauVerifyRunRow } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { closeDatabase, openDbConnection } from '../../engine/db/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { rearmTask } from '../../engine/state/machine.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { handleWorktreePrepare } from '../../engine/worktrees/job.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

describe('T29: End-to-End Worktree & Verifier Integration Test (WX)', () => {
  function runGit(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  }

  it('drives full exit sentence on real GitWorkspaceProvider: queued -> prepare -> worktree -> verify -> send-back checkpoint -> blocked -> rearmTask -> pass -> needs-review', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t29-'));
    const repoPath = path.join(tempDir, 'repo');
    const dbPath = path.join(tempDir, 'test.db');

    // Secret keys for hygiene assertion
    const secretGoogleKey = 'secret-google-key-t29-12345';
    const secretAnthropicKey = 'secret-anthropic-key-t29-67890';
    const secretBureauKey = 'secret-bureau-key-t29-99999';

    process.env.GOOGLE_API_KEY = secretGoogleKey;
    process.env.ANTHROPIC_API_KEY = secretAnthropicKey;
    process.env.BUREAU_SECRET = secretBureauKey;

    // 1. Initialize real Git repo
    fs.mkdirSync(repoPath, { recursive: true });
    runGit(['init'], repoPath);
    runGit(['config', 'user.name', 'Bureau Runner'], repoPath);
    runGit(['config', 'user.email', 'runner@bureau.local'], repoPath);

    fs.writeFileSync(path.join(repoPath, 'README.md'), '# T29 Test Repo\n');
    runGit(['add', '.'], repoPath);
    runGit(['commit', '-m', 'Initial commit'], repoPath);
    runGit(['branch', '-M', 'main'], repoPath);

    const db = openDbConnection(dbPath);
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    // Spy on notifyOperator output by capturing console logs
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string, ...args: any[]) => {
      logs.push(msg);
      originalLog(msg, ...args);
    };

    const taskId = 't29-wx-task';
    const now = new Date().toISOString();

    try {
      // --- Step 1: Insert Queued Task & Enqueue worktree.prepare ---
      db.execTransaction(() => {
        db.run(
          `INSERT INTO bureau_tasks (
            id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 1, ?, ?, ?)`,
          taskId,
          'T29 End-to-End WX Task',
          'Intent',
          'Spec',
          'Acceptance',
          'node fail.js',
          'uuid-t29',
          now,
          now
        );
      });

      const prepJob = enqueueJob(db, {
        kind: 'worktree.prepare',
        task_id: taskId,
        payload: { taskId }
      });

      await handleWorktreePrepare({ db, job: prepJob, payload: { taskId }, signal: new AbortController().signal });

      // Assert task state transitioned queued -> claimed
      const taskAfterPrep = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfterPrep?.state).toBe('claimed');

      // Assert real worktree directory exists on disk
      const wsHandle = await provider.getWorkspaceHandle(db, taskId);
      expect(fs.existsSync(wsHandle.path)).toBe(true);

      // Configure git user on worktree path explicitly for clean git commits
      runGit(['config', 'user.name', 'Bureau Runner'], wsHandle.path);
      runGit(['config', 'user.email', 'runner@bureau.local'], wsHandle.path);

      // Write helper script inside worktree that writes dirty file at runtime and exits 1
      fs.writeFileSync(
        path.join(wsHandle.path, 'fail.js'),
        `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(path.join(__dirname, 'dirty_wip.txt'), 'dirty work in progress');\nprocess.exit(1);\n`
      );

      // Assert verify.run job 1 auto-enqueued by worktree.prepare
      const verifyJobs1 = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
      expect(verifyJobs1.length).toBeGreaterThanOrEqual(1);

      // --- Step 2: Run 1 — Failing Verify & Real Git Checkpoint ---
      const job1 = verifyJobs1[0];
      await executeVerifyRunJob({ db, job: job1, payload: { taskId }, signal: new AbortController().signal });

      let taskAfterRun1 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfterRun1?.state).toBe('claimed');
      expect(taskAfterRun1?.verify_fixes).toBe(1);

      // Assert real git checkpoint commit created in worktree git log with attribution trailer
      const gitLogMsgs = runGit(['log', '-n', '5', '--pretty=format:%B'], wsHandle.path);
      expect(gitLogMsgs).toContain(`bureau-checkpoint: ${taskId} verify-failure-sendback`);
      expect(gitLogMsgs).toContain('Attribution: verifier');

      // Assert junior.dispatch job 1 enqueued for fix round (N1a)
      const juniorJobs1 = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch' AND state = 'pending'", taskId);
      expect(juniorJobs1.length).toBeGreaterThanOrEqual(1);

      // --- Step 3: Run 2 — Failure 2 ---
      // Update fail.js to write another dirty file
      fs.writeFileSync(
        path.join(wsHandle.path, 'fail.js'),
        `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(path.join(__dirname, 'dirty_wip2.txt'), 'dirty work 2');\nprocess.exit(1);\n`
      );

      const job2 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
      await executeVerifyRunJob({ db, job: job2, payload: { taskId }, signal: new AbortController().signal });

      let taskAfterRun2 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfterRun2?.state).toBe('claimed');
      expect(taskAfterRun2?.verify_fixes).toBe(2);

      const juniorJobs2 = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'junior.dispatch' AND state = 'pending'", taskId);
      expect(juniorJobs2.length).toBeGreaterThanOrEqual(2);

      // --- Step 4: Run 3 — Failure 3 (Ceiling reached: verify_fixes=2 >= ceiling=2) ---
      const job3 = enqueueJob(db, { kind: 'verify.run', task_id: taskId, payload: { taskId } });
      await executeVerifyRunJob({ db, job: job3, payload: { taskId }, signal: new AbortController().signal });

      let taskAfterRun3 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskAfterRun3?.state).toBe('blocked');
      expect(taskAfterRun3?.verify_fixes).toBe(2);

      // Assert operator notified
      const notifyLogs = logs.filter((l) => l.includes('operator_notified'));
      expect(notifyLogs.some((l) => l.includes(taskId) && l.includes('verify_fixes ceiling reached'))).toBe(true);

      // Assert guardrail span in journal
      const guardrailSpans = db.all<{ kind: string }>("SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'", taskId);
      expect(guardrailSpans.length).toBeGreaterThanOrEqual(1);


      // --- Step 4: Human Operator Re-Arm & Scripted Fix ---
      // 1. Scripted fix: update verify_cmd and write passing script
      db.run('UPDATE bureau_tasks SET verify_cmd = ? WHERE id = ?', 'node pass.js', taskId);
      fs.writeFileSync(path.join(wsHandle.path, 'pass.js'), 'process.exit(0);\n');

      // 2. Operator re-arms via rearmTask single-writer
      const humanAttr: AttributionTuple = {
        actor_role: 'human-operator',
        provider: 'deterministic',
        model: 'core',
        account: 'operator'
      };
      rearmTask(db, taskId, humanAttr);

      let taskRearmed = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskRearmed?.state).toBe('claimed');
      expect(taskRearmed?.verify_fixes).toBe(0);

      // --- Step 5: Run 4 — Passing Verify ---
      const verifyJobsRearmed = db.all<BureauJobRow>("SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
      expect(verifyJobsRearmed.length).toBeGreaterThanOrEqual(1);

      const job4 = verifyJobsRearmed[0];
      await executeVerifyRunJob({ db, job: job4, payload: { taskId }, signal: new AbortController().signal });

      let taskFinal = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      expect(taskFinal?.state).toBe('needs-review');
      expect(taskFinal?.verifier_exit_code).toBe(0);

      // --- Step 6: Invariant & Key Hygiene Assertions ---
      const runRows = db.all<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
      expect(runRows.length).toBe(4);


      // Verify secret keys appear NOWHERE in any SQLite table or journal span
      const tables = ['bureau_tasks', 'bureau_journal', 'bureau_jobs', 'bureau_verify_runs', 'bureau_worktrees', 'bureau_meta'];
      for (const t of tables) {
        const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
        const dump = JSON.stringify(rows);
        expect(dump).not.toContain(secretGoogleKey);
        expect(dump).not.toContain(secretAnthropicKey);
        expect(dump).not.toContain(secretBureauKey);
      }
    } finally {
      console.log = originalLog;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.BUREAU_SECRET;
      closeDatabase();
      if (fs.existsSync(tempDir)) {
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'ignore' });
        } catch {}
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      setWorkspaceProvider(null);
    }
  }, 30000);
});


