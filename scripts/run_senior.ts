/**
 * Run a Senior review — drives a senior reviewer (Claude CLI or ZCode/GLM) over
 * a junior's captured plan or walkthrough, and prints the verdict.
 *
 *   # Review a plan file with the Claude CLI senior:
 *   node --experimental-strip-types scripts/run_senior.ts --senior claude --kind plan --file <plan.md> --title "build a clicker"
 *
 *   # Review the LATEST captured artifacts for a task (reads docs/junior-artifacts/<taskId>/):
 *   node --experimental-strip-types scripts/run_senior.ts --senior claude --kind walkthrough --task <taskId> --title "build a clicker"
 *
 *   # Same, driving the ZCode (Z.ai GLM) senior over CDP (ZCode must be launched with --remote-debugging-port=9335):
 *   node --experimental-strip-types scripts/run_senior.ts --senior zai --kind plan --task <taskId> --title "build a clicker"
 *
 * Seniors do not write code — they read the artifact and return APPROVE / REVISE.
 */
import fs from 'node:fs';
import { getSeniorDriver } from '../engine/harness/senior-seam.ts';
import { assignSenior, usageHint } from '../engine/harness/senior.ts';
import { readLatestArtifacts } from '../engine/harness/junior-artifacts.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const kind = (arg('--kind') ?? 'plan') as 'plan' | 'walkthrough';
  // One senior per review: use --senior if given, else the assignment policy.
  const senior = arg('--senior') ?? assignSenior({ kind });
  const model = arg('--model');
  const title = arg('--title') ?? 'Untitled task';
  const spec = arg('--spec');
  const file = arg('--file');
  const task = arg('--task');

  if (!arg('--senior')) console.log(`[senior] assigned '${senior}' for ${kind} review (one reviewer). Usage: ${usageHint(senior)}`);

  let plan = '';
  let walkthrough = '';
  if (file) {
    const text = fs.readFileSync(file, 'utf8');
    if (kind === 'plan') plan = text;
    else walkthrough = text;
  } else if (task) {
    const art = readLatestArtifacts(task);
    plan = art.plan || art.reply;
    walkthrough = art.walkthrough || art.reply;
    console.log(`[senior] read artifacts from ${art.dir || '(none found)'}`);
  } else {
    throw new Error('Provide --file <path> or --task <taskId> to review.');
  }

  console.log(`[senior ${senior}] reviewing ${kind} for: ${JSON.stringify(title)}${model ? ` (model ${model})` : ''} ...`);
  const driver = getSeniorDriver(senior);
  const result = await driver.review({ kind, taskTitle: title, taskSpec: spec, plan, walkthrough, model });

  console.log(`\n=== VERDICT (${result.senior}): ${result.verdict.toUpperCase()} ===`);
  console.log(result.feedback);
}

main().catch(err => {
  console.error('[senior] FAILED:', err.message);
  process.exit(1);
});
