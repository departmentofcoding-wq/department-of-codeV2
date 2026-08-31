import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BureauJobRow, BureauTaskRow } from '../../engine/contract/index.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { closeDatabase, openDbConnection } from '../../engine/db/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { handleWorktreePrepare } from '../../engine/worktrees/job.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';

/**
 * N1 / defect 2, full-flow regression through executeVerifyRunJob (NOT just
 * handleVerifyOutcome in isolation). This reproduces the real job-table state
 * the senior flagged: handleVerifyOutcome runs INSIDE the current verify.run
 * job's transaction, before completeJob, so that job is still `running`. The
 * stale-approval re-review's idempotency guard must exclude it, or work.cycle
 * is never enqueued and the task strands at `claimed` with no live job.
 */
describe('N1 flow: verify passes with a stale approval → re-review enqueued (real job row)', () => {
  function runGit(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  it('lands at claimed and enqueues work.cycle despite the running verify.run job', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n1flow-'));
    const repoPath = path.join(tempDir, 'repo');
    const dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(repoPath, { recursive: true });
    runGit(['init'], repoPath);
    runGit(['config', 'user.name', 'Bureau Runner'], repoPath);
    runGit(['config', 'user.email', 'runner@bureau.local'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# N1 flow repo\n');
    runGit(['add', '.'], repoPath);
    runGit(['commit', '-m', 'Initial commit'], repoPath);
    runGit(['branch', '-M', 'main'], repoPath);

    const db = openDbConnection(dbPath);
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    const taskId = 'n1flow-task';
    const now = new Date().toISOString();

    try {
      db.execTransaction(() => {
        db.run(
          `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, verify_cmd, state, verify_fixes, priority, work_uuid, created_at, updated_at)
           VALUES (?, 'N1 flow', 'i', 's', 'a', 'node -e "process.exit(0)"', 'queued', 0, 1, 'uuid-n1flow', ?, ?)`,
          taskId, now, now
        );
      });

      // Prepare a real worktree (queued -> claimed, auto-enqueues verify.run).
      const prepJob = enqueueJob(db, { kind: 'worktree.prepare', task_id: taskId, payload: { taskId } });
      await handleWorktreePrepare({ db, job: prepJob, payload: { taskId }, signal: new AbortController().signal });
      expect(db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!.state).toBe('claimed');

      // Seed an APPROVED work review whose reviewed_commit is a STALE hash — NOT
      // the worktree tip — simulating a sendback that moved the tip past the
      // approval.
      db.run(
        `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
         VALUES ('wr-stale', ?, 'uuid-n1flow', 'walkthrough', 1, 'approved', '0000000000000000000000000000000000000000', 'senior-engineer', 'claude', 'opus', ?)`,
        taskId, now
      );

      // Run the auto-enqueued (passing) verify. Its job row is `running` while
      // handleVerifyOutcome executes.
      const verifyJob = db.get<BureauJobRow>(
        "SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'verify.run' AND state = 'pending' ORDER BY created_at LIMIT 1",
        taskId
      )!;
      await executeVerifyRunJob({ db, job: verifyJob, payload: { taskId }, signal: new AbortController().signal });

      // Stale approval → re-review, NOT needs-review.
      const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId)!;
      expect(task.state).toBe('claimed');

      // The senior's bug: work.cycle must actually be enqueued even though the
      // current verify.run job was `running` during the check.
      const workCycle = db.all<BureauJobRow>(
        "SELECT * FROM bureau_jobs WHERE task_id = ? AND kind = 'work.cycle'",
        taskId
      );
      expect(workCycle.length).toBe(1);

      // The task is NOT stranded — a live job exists to advance it.
      const liveJobs = db.all<BureauJobRow>(
        "SELECT * FROM bureau_jobs WHERE task_id = ? AND state IN ('pending','running')",
        taskId
      );
      expect(liveJobs.length).toBeGreaterThanOrEqual(1);

      const guardrails = db.all<{ detail: string }>(
        "SELECT detail FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'",
        taskId
      );
      expect(guardrails.some((g) => g.detail.includes('verify_passed_stale_approval'))).toBe(true);
    } finally {
      closeDatabase();
      try { execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'ignore' }); } catch {}
      fs.rmSync(tempDir, { recursive: true, force: true });
      setWorkspaceProvider(null);
    }
  }, 30000);
});
