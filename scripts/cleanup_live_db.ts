/**
 * Clean experimental residue out of the LIVE bureau DB — stranded pending jobs
 * and tasks stuck in non-terminal states by dead experiments. This is bureau
 * property, so the script is deliberate: dry-run by default, --apply to execute,
 * and --apply always takes a file backup first. Every change is journaled as an
 * attributed system span.
 *
 * What it does (per --task <taskId>, repeatable):
 *   - marks that task's PENDING jobs 'dead' (with the reason in last_error) —
 *     a pending junior.dispatch from a dead experiment is live ammunition: it
 *     would fire for real the moment a runner starts looping;
 *   - with --block-task <taskId> (repeatable): transitions a stuck 'claimed'
 *     task to 'blocked' through the state machine (senior-gated), reason recorded.
 *
 * It never touches the console's standing rows (console-*), done/failed jobs,
 * or tasks in healthy states. Console action rows (console-watchdog.sweep-latest
 * etc.) are intentionally left pending — they are the Console's own buttons and
 * are re-armed by design.
 *
 *   node --experimental-strip-types scripts/cleanup_live_db.ts --task X --block-task Y         # dry run
 *   node --experimental-strip-types scripts/cleanup_live_db.ts --task X --block-task Y --apply # execute
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDbConnection } from '../engine/db/index.ts';
import { FOREMAN_ATTRIBUTION } from '../engine/jobs/jobs.ts';
import { journal } from '../engine/journal/writer.ts';
import { transition } from '../engine/state/machine.ts';
import { SENIOR_RUBRIC_ATTRIBUTION } from '../engine/review/plan_review_job.ts';
import type { BureauJobRow, BureauTaskRow } from '../engine/contract/types.ts';

function args(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const tasks = args('--task');
  const blockTasks = args('--block-task');
  if (tasks.length === 0 && blockTasks.length === 0) {
    throw new Error('Nothing to do: pass --task <id> (kill its pending jobs) and/or --block-task <id>.');
  }

  const db = openDbConnection();
  try {
    if (apply) {
      const dbPath = process.env.BUREAU_DB_PATH || path.join(process.cwd(), 'db', 'bureau.db');
      const backupDir = path.join(path.dirname(dbPath), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `bureau.db.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.copyFileSync(dbPath, backup);
      console.log(`[cleanup] backup written: ${backup}`);
    }
    console.log(`[cleanup] mode = ${apply ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}`);

    for (const taskId of tasks) {
      const pending = db.all<BureauJobRow>(
        `SELECT * FROM bureau_jobs WHERE task_id = ? AND state = 'pending' AND id NOT LIKE 'console-%'`,
        taskId
      );
      console.log(`[cleanup] task ${taskId}: ${pending.length} pending job(s) to kill`);
      for (const job of pending) {
        console.log(`[cleanup]   → ${job.kind} (${job.id})`);
        if (!apply) continue;
        const now = new Date().toISOString();
        db.execTransaction(() => {
          db.run(
            `UPDATE bureau_jobs SET state = 'dead', last_error = ?, finished_at = ?, run_after = NULL,
             lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND state = 'pending'`,
            'cancelled as experimental residue (cleanup_live_db)',
            now,
            job.id
          );
          journal(db, {
            kind: 'system',
            attribution: FOREMAN_ATTRIBUTION,
            taskId,
            jobId: job.id,
            detail: { action: 'residue_job_cancelled', kind: job.kind, reason: 'experimental residue' }
          });
        });
      }
    }

    for (const taskId of blockTasks) {
      const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
      if (!task) {
        console.log(`[cleanup] block-task ${taskId}: NOT FOUND, skipped`);
        continue;
      }
      if (task.state !== 'claimed') {
        console.log(`[cleanup] block-task ${taskId}: state is '${task.state}', not claimed — skipped`);
        continue;
      }
      console.log(`[cleanup] task ${taskId}: claimed → blocked (abandoned experiment)`);
      if (apply) {
        transition(db, taskId, 'blocked', SENIOR_RUBRIC_ATTRIBUTION, {
          reason: 'abandoned_experiment_residue'
        });
      }
    }

    if (apply) {
      const still = db.all<BureauJobRow>(`SELECT id, kind, task_id FROM bureau_jobs WHERE state = 'pending'`);
      console.log(`[cleanup] remaining pending jobs: ${still.length}`);
      for (const j of still) console.log(`[cleanup]   · ${j.kind} ${j.id} task=${j.task_id ?? '-'}`);
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('[cleanup] FAILED:', err.message);
  process.exit(1);
});
