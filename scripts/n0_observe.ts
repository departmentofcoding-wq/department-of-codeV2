/**
 * N0 live observation v2 (throwaway harness script — not part of the engine).
 *
 * Drives junior A (Antigravity IDE @9333): run a 90s terminal subprocess, wait,
 * then reply with a marker. Samples the engine's activity probe every ~2s and
 * DOM recon every ~10s. Tracks:
 *   - when the CURRENT completion rule (idle+stable x2) would fire,
 *   - whether a terminal "Cancel (Ctrl+D)" control exists during the gap,
 *   - whether the agent RESUMES working on its own when the subprocess ends.
 * Marker is detected ONLY in the reply region (after the prompt), never in the
 * echoed prompt itself.
 *
 *   node --experimental-strip-types scripts/n0_observe.ts
 */
import { AntigravitySession, ensureJuniorRunning, findMainWindowWs, resolveJunior } from '../engine/harness/antigravity.ts';

const JUNIOR = 'A';
const SUBPROCESS_MS = 90000;
const TOTAL_MS = 6 * 60 * 1000;

const PROMPT =
  `Controlled harness observation. Do exactly this and nothing else: ` +
  `run this exact command in your terminal: ` +
  `node -e "setTimeout(()=>console.log('SUBPROCESS-DONE'), ${SUBPROCESS_MS})" ` +
  `then WAIT until it prints SUBPROCESS-DONE (about 90 seconds — do not do anything else while it runs, ` +
  `do not edit any files), and only after it finishes reply with exactly: N0-OBSERVATION-COMPLETE`;

interface Sample { t: number; working: boolean; canSend: boolean; len: number; termCancel: boolean }

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
  console.log(`[n0-observe] prompt sent at ${new Date().toISOString()}`);
  await s.sendPrompt(PROMPT);

  const t0 = Date.now();
  const samples: Sample[] = [];
  let reconAt = -10;
  let markerSeenAt: number | null = null;
  let resumedAfterGap = false;
  let gapEnded = false;

  while (Date.now() - t0 < TOTAL_MS) {
    await new Promise(r => setTimeout(r, 2000));
    const t = Math.round((Date.now() - t0) / 1000);
    let a: { working: boolean; canSend: boolean; len: number };
    let termCancel = false;
    try {
      a = await anyS.probeActivity();
      // The terminal's cancel control (present while a terminal process runs).
      termCancel = !!(await anyS.evaluate(`(() => {
        const btns = [...document.querySelectorAll('button,[role=button]')];
        return btns.some(b => /^cancel/i.test(((b.getAttribute('aria-label')||b.innerText)||'').trim()));
      })()`));
    } catch (e) {
      console.log(`[n0-observe] probe failed: ${(e as Error).message}`);
      break;
    }
    const prev = samples[samples.length - 1];
    samples.push({ t, ...a, termCancel });
    console.log(`[n0-observe] t=${t}s working=${a.working} canSend=${a.canSend} len=${a.len} termCancel=${termCancel}`);

    // The CURRENT rule: idle+stable x2 after any activity => completed.
    const n = samples.length;
    if (n >= 3) {
      const p1 = samples[n - 2], p2 = samples[n - 1], p3 = samples[n - 3];
      const sawActivity = samples.some(x => x.working || x.len !== samples[0].len);
      const steady = p1.len === p2.len && p2.len === p3.len;
      if (sawActivity && !p2.working && p2.canSend && p1.canSend && !p1.working && steady && !p3.working && p3.canSend) {
        console.log(`[n0-observe] *** CURRENT RULE WOULD COMPLETE at t=${t}s (idle+stable since t=${p1.t}s) — termCancel=${termCancel} ***`);
        // Track whether the agent RESUMES on its own after this false completion.
        gapEnded = true;
      }
    }
    if (gapEnded && a.working && !resumedAfterGap) {
      resumedAfterGap = true;
      console.log(`[n0-observe] ### AGENT RESUMED WORKING at t=${t}s after a would-have-completed idle gap ###`);
    }

    // Recon every ~10s: what chrome exists outside the composer?
    if (t - reconAt >= 10) {
      reconAt = t;
      try {
        const recon = await anyS.evaluate(`(() => {
          const btns = [...document.querySelectorAll('button,[role=button]')];
          const labels = {};
          for (const b of btns) {
            const l = ((b.getAttribute('aria-label')||b.innerText)||'').trim().slice(0,44);
            if (l) labels[l] = (labels[l]||0)+1;
          }
          const busyish = [...document.querySelectorAll('[class*=spin],[class*=loading],[class*=progress],[aria-busy=true]')].length;
          const xterm = document.querySelectorAll('.xterm-rows, [class*=terminal]').length;
          return JSON.stringify({ busyish, xterm, labels });
        })()`);
        const r = JSON.parse(recon);
        const interesting = Object.entries(r.labels).filter(([l]) => /stop|cancel|kill|run|running|send/i.test(l));
        console.log(`[n0-observe]   recon: busyish=${r.busyish} xterm=${r.xterm} interesting=${JSON.stringify(interesting)}`);
      } catch { /* best-effort */ }
    }

    // Marker ONLY in the reply region (after the prompt) — the echoed prompt
    // contains the string too and must never count.
    if (markerSeenAt === null) {
      try {
        const reply = await s.readAgentReply(PROMPT);
        if (reply && reply.includes('N0-OBSERVATION-COMPLETE')) {
          markerSeenAt = t;
          console.log(`[n0-observe] agent's final marker in REPLY REGION at t=${t}s.`);
        }
      } catch { /* best-effort */ }
    }
    // End only on marker + idle sustained.
    if (markerSeenAt !== null && !a.working && a.canSend && prev && !prev.working) {
      console.log(`[n0-observe] genuine completion (marker + idle) at t=${t}s. resumedAfterGap=${resumedAfterGap}.`);
      break;
    }
  }
  if (markerSeenAt === null) console.log(`[n0-observe] ended: marker never appeared in reply region. resumedAfterGap=${resumedAfterGap}.`);
  s.close();
}

main().catch(err => { console.error('[n0-observe] FAILED:', err.message); process.exit(1); });
