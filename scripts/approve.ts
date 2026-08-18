import readline from 'node:readline';
import type { AttributionTuple, BureauTaskRow, DbConnection } from '../engine/contract/types.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { approveTask } from '../engine/state/machine.ts';

export interface TaskAuditSummary {
  taskId: string;
  title: string;
  intent: string | null;
  state: string;
  verifierExitCode: number | null;
  verifyRunCount: number;
  latestPlanVerdict: string | null;
  latestWorkVerdict: string | null;
  reviewedCommit: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}

export function listNeedsReviewTasks(db: DbConnection): TaskAuditSummary[] {
  const tasks = db.all<BureauTaskRow>(
    "SELECT * FROM bureau_tasks WHERE state = 'needs-review' ORDER BY created_at ASC"
  );

  return tasks.map((task) => {
    const runsCountRow = db.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM bureau_verify_runs WHERE task_id = ?',
      task.id
    );
    const verifyRunCount = runsCountRow ? runsCountRow.cnt : 0;

    const latestPlanReview = db.get<{ verdict: string }>(
      'SELECT verdict FROM bureau_plan_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      task.id
    );

    const latestWorkReview = db.get<{ verdict: string; reviewed_commit: string | null }>(
      'SELECT verdict, reviewed_commit FROM bureau_work_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      task.id
    );

    return {
      taskId: task.id,
      title: task.title,
      intent: task.intent,
      state: task.state,
      verifierExitCode: task.verifier_exit_code,
      verifyRunCount,
      latestPlanVerdict: latestPlanReview?.verdict || null,
      latestWorkVerdict: latestWorkReview?.verdict || null,
      reviewedCommit: latestWorkReview?.reviewed_commit || null,
      approvedAt: task.approved_at,
      approvedBy: task.approved_by
    };
  });
}

export function approveTaskInteractive(
  db: DbConnection,
  taskId: string,
  confirmationInput: string,
  actor: AttributionTuple
): BureauTaskRow {
  const expectedConfirmation = `${taskId} CONFIRM`;
  if (confirmationInput.trim() !== expectedConfirmation) {
    throw new Error(`Confirmation mismatch. Expected '${expectedConfirmation}', received '${confirmationInput.trim()}'`);
  }

  return approveTask(db, taskId, actor);
}

// CLI interactive runner
if (process.argv[1] && process.argv[1].endsWith('approve.ts')) {
  const dbPath = process.env.BUREAU_DB_PATH || 'db/bureau.db';
  const db = openDbConnection(dbPath);

  const humanAttr: AttributionTuple = {
    actor_role: 'human-operator',
    provider: 'human',
    model: 'operator',
    account: process.env.USER || 'admin'
  };

  const tasks = listNeedsReviewTasks(db);

  if (tasks.length === 0) {
    console.log('No tasks currently in needs-review state.');
    process.exit(0);
  }

  console.log('=== Tasks Pending Operator Approval ===');
  tasks.forEach((t, i) => {
    console.log(`\n[${i + 1}] Task ID: ${t.taskId}`);
    console.log(`    Title: ${t.title}`);
    console.log(`    Verifier Exit Code: ${t.verifierExitCode} (runs: ${t.verifyRunCount})`);
    console.log(`    Latest Plan Verdict: ${t.latestPlanVerdict || 'N/A'}`);
    console.log(`    Latest Work Verdict: ${t.latestWorkVerdict || 'N/A'} (commit: ${t.reviewedCommit || 'N/A'})`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('\nEnter Task ID to approve: ', (targetId) => {
    const trimmedId = targetId.trim();
    if (!trimmedId) {
      console.log('Aborted: empty task ID');
      rl.close();
      process.exit(1);
    }

    rl.question(`To confirm approval of ${trimmedId}, type '${trimmedId} CONFIRM': `, (confirmInput) => {
      try {
        const result = approveTaskInteractive(db, trimmedId, confirmInput, humanAttr);
        console.log(`\nSUCCESS: Task ${result.id} approved by ${result.approved_by} at ${result.approved_at}`);
        console.log('Job pr.create has been enqueued.');
      } catch (err: any) {
        console.error(`\nAPPROVAL REFUSED: ${err.message}`);
        process.exitCode = 1;
      } finally {
        rl.close();
      }
    });
  });
}
