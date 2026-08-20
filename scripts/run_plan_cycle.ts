/**
 * Run the plan-review cycle for a task: junior AUTHORS the plan, then the senior
 * REVIEWS it (with the task verbatim). Writes real bureau_plans / bureau_plan_reviews
 * rows and journal spans.
 *
 *   node --experimental-strip-types scripts/run_plan_cycle.ts --task <taskId> \
 *     --junior B --senior claude
 *
 * Optional: --junior-model "Gemini 3.7 Flash"  --senior-model "GLM-4.6"  --folder "..."
 * If --senior is omitted the assignment policy picks one (plans → claude by default).
 */
import { openDbConnection } from '../engine/db/index.ts';
import { runPlanReviewCycle } from '../engine/flow/plan_review_cycle.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const taskId = arg('--task');
  if (!taskId) throw new Error('Provide --task <taskId>.');

  const db = openDbConnection();
  try {
    console.log(`[plan-cycle] task=${taskId} — junior authors plan, senior reviews...`);
    const result = await runPlanReviewCycle(db, {
      taskId,
      junior: arg('--junior'),
      seniorId: arg('--senior'),
      juniorModel: arg('--junior-model'),
      seniorModel: arg('--senior-model'),
      folder: arg('--folder'),
      juniorWaitMs: arg('--junior-wait') ? Number(arg('--junior-wait')) : undefined
    });
    console.log(`\n--- PLAN (by junior ${result.junior}) ---\n${result.planText}`);
    console.log(`\n=== SENIOR ${result.senior.toUpperCase()} VERDICT: ${result.verdict.toUpperCase()} ===`);
    console.log(result.feedback);
    console.log(`\n[plan-cycle] plan ${result.planId} recorded; review written to bureau_plan_reviews.`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('[plan-cycle] FAILED:', err.message);
  process.exit(1);
});
