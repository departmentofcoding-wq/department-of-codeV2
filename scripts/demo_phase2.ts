import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttributionTuple, BureauJournalRow, BureauTaskRow, BureauVerifyRunRow } from '../engine/contract/index.ts';
import { setWorkspaceProvider } from '../engine/contract/workspace-seam.ts';
import { closeDatabase, openDbConnection } from '../engine/db/index.ts';
import { enqueueJob } from '../engine/jobs/jobs.ts';
import { rearmTask } from '../engine/state/machine.ts';
import { executeVerifyRunJob } from '../engine/verify/job.ts';
import { handleWorktreePrepare } from '../engine/worktrees/job.ts';
import { GitWorkspaceProvider } from '../engine/worktrees/manager.ts';

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

async function main() {
  console.log('=== DEPARTMENT OF CODE V2 — PHASE 2 EXIT DEMO (WORKTREES + VERIFIER) ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-demo-phase2-'));
  const repoPath = path.join(tempDir, 'repo');
  const dbPath = path.join(tempDir, 'demo.db');

  // Inject test secrets to demonstrate key hygiene across DB & journal
  const secretKey = 'secret-demo-phase2-key-9999';
  process.env.BUREAU_SECRET = secretKey;

  // 1. Initialize Git Repo
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(['init'], repoPath);
  runGit(['config', 'user.name', 'Bureau Demo Runner'], repoPath);
  runGit(['config', 'user.email', 'demo@bureau.local'], repoPath);

  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Phase 2 Exit Demo Repo\n');
  runGit(['add', '.'], repoPath);
  runGit(['commit', '-m', 'Initial main commit'], repoPath);
  runGit(['branch', '-M', 'main'], repoPath);

  const db = openDbConnection(dbPath);
  const provider = new GitWorkspaceProvider(repoPath);
  setWorkspaceProvider(provider);

  const taskId = 'task-demo-phase2-exit';
  const now = new Date().toISOString();

  try {
    // 2. Queue Task in DB
    console.log('[1] Queuing task in database with failing verify command...');
    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (
          id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 1, ?, ?, ?)`,
        taskId,
        'Phase 2 Exit Demo Task',
        'Demonstrate worktree preparation and verifier send-back loop',
        'Clean worktree + deterministic verifier run + git checkpointing',
        'Task transitions to needs-review with exit code 0 after human re-arm',
        'node fail.js',
        'uuid-phase2-demo',
        now,
        now
      );
    });

    // 3. Prepare Worktree
    console.log('[2] Preparing git worktree via worktree.prepare job...');
    const prepJob = enqueueJob(db, {
      kind: 'worktree.prepare',
      task_id: taskId,
      payload: { taskId }
    });

    await handleWorktreePrepare({ db, job: prepJob, payload: { taskId }, signal: new AbortController().signal });

    const handle = await provider.getWorkspaceHandle(db, taskId);
    runGit(['config', 'user.name', 'Bureau Demo Runner'], handle.path);
    runGit(['config', 'user.email', 'demo@bureau.local'], handle.path);

    console.log(`    Worktree created at: ${handle.path}`);
    console.log(`    Base Commit: ${handle.baseCommit}`);

    // Write helper script inside worktree that writes dirty file at runtime and exits 1
    fs.writeFileSync(
      path.join(handle.path, 'fail.js'),
      `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(path.join(__dirname, 'wip.txt'), 'dirty work');\nprocess.exit(1);\n`
    );

    // 4. Run 1: Verify Failure 1 (verify_fixes 0 -> 1)
    console.log('\n[3] Executing Verify Run 1 (Failing verify command -> send-back 1)...');
    const verifyJob1 = db.get<{ id: string }>("SELECT id FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
    if (!verifyJob1) throw new Error('verify.run job 1 not found');

    const job1 = db.get<any>('SELECT * FROM bureau_jobs WHERE id = ?', verifyJob1.id);
    await executeVerifyRunJob({ db, job: job1, payload: { taskId }, signal: new AbortController().signal });

    let task1 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    console.log(`    Outcome: state=${task1?.state}, verify_fixes=${task1?.verify_fixes}`);

    const checkpointLog1 = runGit(['log', '-1', '--pretty=format:%B'], handle.path);
    console.log(`    Git Checkpoint Commit Message:\n    ${checkpointLog1.replace(/\n/g, '\n    ')}`);

    // 5. Run 2: Verify Failure 2 (verify_fixes 1 -> 2)
    console.log('\n[4] Executing Verify Run 2 (Failing verify command -> send-back 2)...');
    fs.writeFileSync(
      path.join(handle.path, 'fail.js'),
      `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(path.join(__dirname, 'wip2.txt'), 'dirty work 2');\nprocess.exit(1);\n`
    );

    const verifyJob2 = db.get<{ id: string }>("SELECT id FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
    if (!verifyJob2) throw new Error('verify.run job 2 not found');

    const job2 = db.get<any>('SELECT * FROM bureau_jobs WHERE id = ?', verifyJob2.id);
    await executeVerifyRunJob({ db, job: job2, payload: { taskId }, signal: new AbortController().signal });

    let task2 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    console.log(`    Outcome: state=${task2?.state}, verify_fixes=${task2?.verify_fixes}`);

    // 6. Run 3: Failure 3 (verify_fixes 2 >= ceiling 2 -> blocked)
    console.log('\n[5] Executing Verify Run 3 (Third failure -> budget ceiling breach)...');
    fs.writeFileSync(
      path.join(handle.path, 'fail.js'),
      `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(path.join(__dirname, 'wip3.txt'), 'dirty work 3');\nprocess.exit(1);\n`
    );

    const verifyJob3 = db.get<{ id: string }>("SELECT id FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
    if (!verifyJob3) throw new Error('verify.run job 3 not found');

    const job3 = db.get<any>('SELECT * FROM bureau_jobs WHERE id = ?', verifyJob3.id);
    await executeVerifyRunJob({ db, job: job3, payload: { taskId }, signal: new AbortController().signal });

    let task3 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    console.log(`    Outcome: state=${task3?.state} (Expected: blocked), verify_fixes=${task3?.verify_fixes}`);

    // 7. Human Operator Re-Arm & Scripted Fix
    console.log('\n[6] Human Operator re-arming task & applying scripted fix...');
    db.run('UPDATE bureau_tasks SET verify_cmd = ? WHERE id = ?', 'node pass.js', taskId);
    fs.writeFileSync(path.join(handle.path, 'pass.js'), 'process.exit(0);\n');

    rearmTask(db, taskId, humanAttr);

    let taskRearmed = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    console.log(`    Task re-armed: state=${taskRearmed?.state} (Expected: claimed), verify_fixes=${taskRearmed?.verify_fixes}`);

    // 8. Run 4: Passing Verify Run
    console.log('\n[7] Executing Verify Run 4 (Passing verify command)...');
    const verifyJob4 = db.get<{ id: string }>("SELECT id FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending'", taskId);
    if (!verifyJob4) throw new Error('verify.run job 4 not found');

    const job4 = db.get<any>('SELECT * FROM bureau_jobs WHERE id = ?', verifyJob4.id);
    await executeVerifyRunJob({ db, job: job4, payload: { taskId }, signal: new AbortController().signal });

    let taskFinal = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
    console.log(`    Final Outcome: state=${taskFinal?.state} (Expected: needs-review), verifier_exit_code=${taskFinal?.verifier_exit_code}`);

    // 9. Output Summary & Journal Spans
    const runRows = db.all<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', taskId);
    console.log(`\n=== VERIFY RUNS SUMMARY (${runRows.length} runs) ===`);
    for (const r of runRows) {
      console.log(`- Run ID: ${r.id} | Exit Code: ${r.exit_code} | Timed Out: ${r.timed_out} | Duration: ${r.duration_ms}ms`);
    }

    const journalSpans = db.all<BureauJournalRow>('SELECT * FROM bureau_journal ORDER BY id ASC');
    console.log(`\n=== JOURNAL ATTRIBUTION SUMMARY (${journalSpans.length} spans) ===`);
    for (const s of journalSpans) {
      console.log(`- [${s.kind}] actor: ${s.actor_role} (${s.provider}/${s.model}) detail: ${s.detail}`);
    }

    // Secret Hygiene Verification
    const tables = ['bureau_tasks', 'bureau_journal', 'bureau_jobs', 'bureau_verify_runs', 'bureau_worktrees', 'bureau_meta'];
    for (const t of tables) {
      const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
      const dump = JSON.stringify(rows);
      if (dump.includes(secretKey)) {
        throw new Error(`Secret key leaked into table ${t}!`);
      }
    }
    console.log('\n[8] Key Hygiene Check: PASS (Zero secrets found in SQLite database or journal)');
    console.log('\n=== PHASE 2 EXIT DEMO COMPLETED SUCCESSFULLY ===');
  } finally {
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
}

void main();
