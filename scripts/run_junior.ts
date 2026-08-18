/**
 * Run the Junior — drives the Antigravity IDE agent from the command line.
 *
 *   node --experimental-strip-types scripts/run_junior.ts "your command here"
 *   node --experimental-strip-types scripts/run_junior.ts --port 9333 "..."
 *   node --experimental-strip-types scripts/run_junior.ts --status   (detect only)
 *
 * Detects whether Antigravity is already exposing a CDP endpoint; if not, opens
 * it with the debug port. Then attaches to the main window and (unless --status)
 * types the command into the agent chat and prints the transcript tail.
 */
import {
  ANTIGRAVITY_DEFAULT_PORT,
  ensureAntigravityRunning,
  findMainWindowWs,
  AntigravitySession
} from '../engine/harness/antigravity.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const port = Number(arg('--port') ?? ANTIGRAVITY_DEFAULT_PORT);
  const statusOnly = process.argv.includes('--status');
  const prompt = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== arg('--port')).join(' ').trim();

  console.log(`[junior] ensuring Antigravity is running (CDP port ${port})...`);
  const ensured = await ensureAntigravityRunning(port);
  console.log(`[junior] ${ensured.launched ? 'launched a new' : 'attached to the existing'} Antigravity instance.`);

  // The main window can take a few seconds to leave the loading splash.
  let wsUrl = '';
  for (let i = 0; i < 20; i++) {
    try {
      wsUrl = await findMainWindowWs(port);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  if (!wsUrl) throw new Error('Main Antigravity window did not become available in time.');

  const session = new AntigravitySession(wsUrl);
  await session.connect();
  console.log('[junior] attached to the main IDE window.');

  if (statusOnly || !prompt) {
    console.log('[junior] status OK — Antigravity is drivable. (No command given.)');
    session.close();
    return;
  }

  console.log(`[junior] sending command: ${JSON.stringify(prompt)}`);
  await session.sendPrompt(prompt);
  console.log('[junior] submitted. waiting for the agent to respond...');
  await new Promise(r => setTimeout(r, 9000));
  console.log('--- agent reply ---');
  console.log(await session.readAgentReply(prompt));
  session.close();
}

main().catch(err => {
  console.error('[junior] FAILED:', err.message);
  process.exit(1);
});
