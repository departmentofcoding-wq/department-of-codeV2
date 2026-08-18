import {
  ANTIGRAVITY_DEFAULT_PORT,
  AntigravitySession,
  ensureAntigravityRunning,
  findMainWindowWs
} from './antigravity.ts';

/**
 * Seam for driving the Antigravity junior, mirroring the department's other
 * override seams (llm-seam, pr-seam, ide-driver-seam, backup-seam). The real
 * implementation drives a live Antigravity via CDP; tests inject a fake so
 * `junior.dispatch` routing can be verified without a running IDE.
 */
export interface AntigravityRunResult {
  transcript: string;
  launched: boolean;
}

export interface AntigravityDriver {
  runCommand(prompt: string, opts?: { port?: number; waitMs?: number }): Promise<AntigravityRunResult>;
}

class RealAntigravityDriver implements AntigravityDriver {
  async runCommand(prompt: string, opts: { port?: number; waitMs?: number } = {}): Promise<AntigravityRunResult> {
    const port = opts.port ?? ANTIGRAVITY_DEFAULT_PORT;
    const ensured = await ensureAntigravityRunning(port);

    // The workbench window can lag the CDP endpoint by a few seconds.
    let wsUrl = '';
    for (let i = 0; i < 20; i++) {
      try {
        wsUrl = await findMainWindowWs(port);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!wsUrl) throw new Error('Antigravity workbench window did not become available in time.');

    const session = new AntigravitySession(wsUrl);
    await session.connect();
    try {
      await session.sendPrompt(prompt);
      await new Promise(r => setTimeout(r, opts.waitMs ?? 9000));
      const transcript = await session.readAgentReply(prompt);
      return { transcript, launched: ensured.launched };
    } finally {
      session.close();
    }
  }
}

let override: AntigravityDriver | null = null;

export function setAntigravityDriverOverride(driver: AntigravityDriver | null): void {
  override = driver;
}

export function getAntigravityDriver(): AntigravityDriver {
  return override ?? new RealAntigravityDriver();
}
