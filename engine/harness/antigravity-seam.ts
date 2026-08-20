import {
  ANTIGRAVITY_DEFAULT_PORT,
  AntigravitySession,
  ensureAntigravityRunning,
  ensureJuniorRunning,
  findMainWindowWs,
  resolveJunior
} from './antigravity.ts';

/**
 * Seam for driving the Antigravity junior, mirroring the department's other
 * override seams (llm-seam, pr-seam, ide-driver-seam, backup-seam). The real
 * implementation drives a live Antigravity via CDP; tests inject a fake so
 * `junior.dispatch` routing can be verified without a running IDE.
 */
export interface AntigravityRunResult {
  /** The agent's reply to the prompt (chrome-stripped). Back-compat field. */
  transcript: string;
  launched: boolean;
  /** Which junior handled it ('A' | 'B'). */
  junior?: string;
  /** Full visible conversation capture (the whole output). */
  fullOutput?: string;
  /** Implementation plan Antigravity emitted before coding, if any. */
  plan?: string;
  /** Walkthrough Antigravity emitted when done, if any. */
  walkthrough?: string;
  /** Model shown on the picker after selection (when a model was requested). */
  model?: string;
  /** Whether the requested folder/project was selected. */
  folderSelected?: boolean;
}

export interface AntigravityRunOptions {
  /** Which junior to drive: 'A' = Antigravity IDE, 'B' = Antigravity 2.0. */
  junior?: string;
  /** Explicit CDP port override (defaults to the junior's configured port). */
  port?: number;
  /** Milliseconds to wait for the agent after submitting. */
  waitMs?: number;
  /** Model to select in the GUI picker before sending the prompt. */
  model?: string;
  /** Folder/project to select in the GUI before sending the prompt. */
  folder?: string;
  /** Start a fresh conversation first so a prior task can't bleed in. Default true. */
  freshConversation?: boolean;
}

export interface AntigravityDriver {
  runCommand(prompt: string, opts?: AntigravityRunOptions): Promise<AntigravityRunResult>;
}

class RealAntigravityDriver implements AntigravityDriver {
  async runCommand(prompt: string, opts: AntigravityRunOptions = {}): Promise<AntigravityRunResult> {
    // Resolve the target junior. If a bare `port` is given (legacy callers),
    // honor it against the default IDE junior; otherwise use the junior's port.
    const cfg = resolveJunior(opts.junior);
    const ensured =
      opts.port !== undefined && !opts.junior
        ? await ensureAntigravityRunning(opts.port)
        : await ensureJuniorRunning(cfg);
    const port = opts.port ?? cfg.cdpPort;

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
    if (!wsUrl) throw new Error(`${cfg.label} workbench window did not become available in time.`);

    const session = new AntigravitySession(wsUrl);
    await session.connect();
    try {
      let model: string | undefined;
      let folderSelected: boolean | undefined;
      // Fresh conversation per task (unless disabled) prevents an earlier task's
      // plan/context from bleeding into this one — a real bug observed live.
      if (opts.freshConversation !== false) {
        await session.newConversation();
        await new Promise(r => setTimeout(r, 800));
      }
      if (opts.folder) folderSelected = await session.selectFolder(opts.folder);
      if (opts.model) model = await session.selectModel(opts.model);

      await session.sendPrompt(prompt);
      // Wait adaptively: keep extending while the junior is working; no hard cap.
      // `waitMs`, if given, is used only as the inactivity (stall) window.
      await session.waitForCompletion({ stallMs: opts.waitMs ?? 120000 });

      const artifacts = await session.captureArtifacts(prompt);
      return {
        transcript: artifacts.reply,
        fullOutput: artifacts.transcript,
        plan: artifacts.plan,
        walkthrough: artifacts.walkthrough,
        launched: ensured.launched,
        junior: cfg.id,
        model,
        folderSelected
      };
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
