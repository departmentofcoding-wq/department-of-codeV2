/**
 * Run a Junior — drives an Antigravity agent (IDE or 2.0) from the command line.
 *
 *   node --experimental-strip-types scripts/run_junior.ts "your command here"
 *   node --experimental-strip-types scripts/run_junior.ts --junior B "..."
 *   node --experimental-strip-types scripts/run_junior.ts --junior B --model "Gemini 3.7 Flash" --folder "Dept of code v2" "..."
 *   node --experimental-strip-types scripts/run_junior.ts --port 9333 "..."
 *   node --experimental-strip-types scripts/run_junior.ts --status   (detect only)
 *
 * Junior A = Antigravity IDE (port 9333), Junior B = Antigravity 2.0 (port 9334).
 * Detects a live CDP endpoint or launches the app with its debug port, attaches
 * to the workbench window, optionally selects a model + folder in the GUI, then
 * (unless --status) sends the command and prints the reply, plan, and walkthrough.
 */
import {
  AntigravitySession,
  ensureAntigravityRunning,
  ensureJuniorRunning,
  findMainWindowWs,
  resolveJunior
} from '../engine/harness/antigravity.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const juniorId = arg('--junior');
  const cfg = resolveJunior(juniorId);
  const portArg = arg('--port');
  const model = arg('--model');
  const folder = arg('--folder');
  const statusOnly = process.argv.includes('--status');

  const consumed = new Set(['--junior', '--port', '--model', '--folder', juniorId, portArg, model, folder]);
  const prompt = process.argv
    .slice(2)
    .filter(a => !a.startsWith('--') && !consumed.has(a))
    .join(' ')
    .trim();

  const port = portArg ? Number(portArg) : cfg.cdpPort;
  console.log(`[junior ${cfg.id}] ensuring ${cfg.label} is running (CDP port ${port})...`);
  const ensured = portArg
    ? await ensureAntigravityRunning(port)
    : await ensureJuniorRunning(cfg);
  console.log(`[junior ${cfg.id}] ${ensured.launched ? 'launched a new' : 'attached to an existing'} instance.`);

  let wsUrl = '';
  for (let i = 0; i < 20; i++) {
    try {
      wsUrl = await findMainWindowWs(port);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  if (!wsUrl) throw new Error(`${cfg.label} workbench window did not become available in time.`);

  const session = new AntigravitySession(wsUrl);
  await session.connect();
  console.log(`[junior ${cfg.id}] attached to the workbench window.`);

  if (statusOnly || !prompt) {
    console.log(`[junior ${cfg.id}] status OK — ${cfg.label} is drivable. (No command given.)`);
    session.close();
    return;
  }

  if (folder) {
    const ok = await session.selectFolder(folder);
    console.log(`[junior ${cfg.id}] folder ${JSON.stringify(folder)}: ${ok ? 'selected' : 'NOT FOUND'}`);
  }
  if (model) {
    const now = await session.selectModel(model);
    console.log(`[junior ${cfg.id}] model set to: ${now}`);
  }

  console.log(`[junior ${cfg.id}] sending command: ${JSON.stringify(prompt)}`);
  await session.sendPrompt(prompt);
  console.log(`[junior ${cfg.id}] submitted. waiting for the agent to respond...`);
  await new Promise(r => setTimeout(r, 9000));

  const art = await session.captureArtifacts(prompt);
  console.log('--- agent reply ---');
  console.log(art.reply || '(no reply captured)');
  if (art.plan) {
    console.log('\n--- implementation plan ---');
    console.log(art.plan);
  }
  if (art.walkthrough) {
    console.log('\n--- walkthrough ---');
    console.log(art.walkthrough);
  }
  session.close();
}

main().catch(err => {
  console.error('[junior] FAILED:', err.message);
  process.exit(1);
});
