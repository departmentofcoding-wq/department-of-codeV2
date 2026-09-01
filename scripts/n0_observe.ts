/**
 * N0 live observation v3 (throwaway harness script — not part of the engine).
 *
 * Round 2 (post senior-REVISE): drives junior A with a REALISTIC multi-line
 * department-shaped prompt (TASK block + JUNIOR_COMPLETION_INSTRUCTION) that
 * forces a 90s terminal subprocess then a marker-ended final message, and waits
 * using the SHIPPED gate — waitForAgentIdle with completionEvidence wired to
 * juniorCompletionEvidence (line-aware reply-region check) — logging every tick.
 * Expected: awaiting-evidence ticks through the subprocess gap, `completed` only
 * after the agent's real final marker, no echo false-positive.
 *
 *   node --experimental-strip-types scripts/n0_observe.ts
 */
import {
  AntigravitySession,
  ensureJuniorRunning,
  findMainWindowWs,
  resolveJunior,
  JUNIOR_COMPLETION_INSTRUCTION,
  juniorCompletionEvidence
} from '../engine/harness/antigravity.ts';
import { waitForAgentIdle } from '../engine/harness/agent-wait.ts';

const JUNIOR = 'A';
const SUBPROCESS_MS = 90000;

// Realistic multi-line department prompt shape (mirrors buildImplementationPrompt).
const PROMPT = [
  'Controlled harness observation. Do exactly this and nothing else.',
  '',
  '===== TASK =====',
  'TITLE: Subprocess-gap completion observation',
  'INTENT: verify the N0 completion gate holds through a terminal subprocess gap',
  'SPEC: run the command below, wait, then post the final marker',
  'ACCEPTANCE: the final message ends with the completion line',
  '',
  'Run this exact command in your terminal:',
  `node -e "setTimeout(()=>console.log('SUBPROCESS-DONE'), ${SUBPROCESS_MS})"`,
  'then WAIT until it prints SUBPROCESS-DONE (about 90 seconds — do not do anything else',
  'while it runs, do not edit any files), and only after it finishes post your final',
  'message confirming it completed.',
  '',
  JUNIOR_COMPLETION_INSTRUCTION
].join('\n');

async function main(): Promise<void> {
  const cfg = resolveJunior(JUNIOR);
  await ensureJuniorRunning(cfg);
  let wsUrl = '';
  for (let i = 0; i < 30 && !wsUrl; i++) {
    try { wsUrl = await findMainWindowWs(cfg.cdpPort); } catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  if (!wsUrl) throw new Error('workbench window did not become available');
  const s = new AntigravitySession(wsUrl);
  await s.connect();
  const anyS = s as any;

  if (!(await s.ensureChatInputReady(30000))) throw new Error('chat input not ready');
  if (!(await s.newConversation())) throw new Error('could not start a fresh conversation');
  const t0 = Date.now();
  console.log(`[n0-observe] multi-line prompt sent at ${new Date().toISOString()}`);
  await s.sendPrompt(PROMPT);

  // The SHIPPED gate, exactly as the seam wires it.
  const result = await waitForAgentIdle(() => anyS.probeActivity(), {
    stallMs: 120000,
    evidenceTimeoutMs: 300000,
    completionEvidence: async () => juniorCompletionEvidence(await s.readTranscript(250), PROMPT),
    onTick: i =>
      console.log(`[n0-observe] t=${Math.round((Date.now() - t0) / 1000)}s ${i.status} (working=${i.activity.working} canSend=${i.activity.canSend} len=${i.activity.len})`)
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (result === 'completed') {
    const reply = await s.readAgentReply(PROMPT);
    console.log(`[n0-observe] COMPLETED at t=${secs}s. Marker in reply region: ${reply.includes('BUREAU-JUNIOR-COMPLETE')}.`);
    console.log(`[n0-observe] reply tail: ${reply.split('\n').filter(Boolean).slice(-4).join(' | ')}`);
  } else {
    console.log(`[n0-observe] RESULT=${result} at t=${secs}s (NOT completed — the gate held or the agent stalled).`);
  }
  s.close();
}

main().catch(err => { console.error('[n0-observe] FAILED:', err.message); process.exit(1); });
