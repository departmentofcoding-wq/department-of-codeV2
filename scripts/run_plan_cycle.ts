/**
 * Run the plan-review cycle for a task — as a real bureau job, through the
 * runner: junior AUTHORS the plan, the deterministic rubric gates it, the
 * senior REVIEWS it (with the task verbatim). Approve enqueues the
 * implementation dispatch; revise enqueues the next round with the feedback.
 *
 *   node --experimental-strip-types scripts/run_plan_cycle.ts --task <taskId> \
 *     --junior B --senior claude
 *
 * Optional: --junior-model "Gemini 3.7 Flash"  --senior-model "GLM-4.6"  --folder "..."
 * If --senior is omitted the assignment policy picks one (plans → claude by default).
 * Set BUREAU_DB_PATH to target a non-live database (experiments never touch db/bureau.db).
 */
import { openDbConnection } from '../engine/db/index.ts';
import { enqueueJob } from '../engine/jobs/jobs.ts';
import { drainSingleJob } from '../runner/main.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const taskId = arg('--task');
  if (!taskId) throw new Error('Provide --task <taskId>.');

  const db = openDbConnection();
  try {
    console.log(`[plan-cycle] task=${taskId} — enqueueing plan.cycle job (junior authors, rubric gates, senior reviews)...`);
    const job = enqueueJob(db, {
      kind: 'plan.cycle',
      task_id: taskId,
      payload: {
        taskId,
        junior: arg('--junior'),
        seniorId: arg('--senior'),
        juniorModel: arg('--junior-model'),
        seniorModel: arg('--senior-model'),
        folder: arg('--folder'),
        ...(arg('--junior-stall') ? { juniorStallMs: Number(arg('--junior-stall')) } : {})
      },
      max_attempts: 1
    });
    await drainSingleJob(db, job.id);

    const done = db.get<{ state: string; last_error: string | null }>(
      'SELECT state, last_error FROM bureau_jobs WHERE id = ?',
      job.id
    );
    const rounds = db.get<{ plan_rounds: number }>(
      'SELECT plan_rounds FROM bureau_tasks WHERE id = ?',
      taskId
    );
    const plan = db.get<{ id: string; plan_text: string }>(
      'SELECT id, plan_text FROM bureau_plans WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      taskId
    );
    const review = plan
      ? db.get<{ verdict: string; feedback: string; provider: string }>(
          'SELECT verdict, feedback, provider FROM bureau_plan_reviews WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1',
          plan.id
        )
      : undefined;

    console.log(`[plan-cycle] job ${job.id} → ${done?.state}${done?.last_error ? ` (${done.last_error})` : ''}`);
    if (plan) console.log(`\n--- PLAN (${plan.id}) ---\n${plan.plan_text}`);
    if (review) {
      console.log(`\n=== REVIEW by ${review.provider.toUpperCase()}: ${review.verdict.toUpperCase()} ===`);
      console.log(review.feedback);
    }
    console.log(`\n[plan-cycle] task plan_rounds=${rounds?.plan_rounds ?? '?'}`);
    if (done?.state !== 'done') process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('[plan-cycle] FAILED:', err.message);
  process.exit(1);
});
