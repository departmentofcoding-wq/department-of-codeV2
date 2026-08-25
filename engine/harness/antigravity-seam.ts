import { ensureCompleted } from './agent-wait.ts';
import {
  ANTIGRAVITY_DEFAULT_PORT,
  ANTIGRAVITY_INPUT_LABEL,
  AntigravitySession,
  ensureAntigravityRunning,
  ensureJuniorRunning,
  findMainWindowWs,
  resolveJunior
} from './antigravity.ts';
import { HarnessError } from './errors.ts';

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
  /** Model label actually in effect: the picker read-back when a model was
   *  requested, else undefined — never a fabricated placeholder. */
  model?: string;
  /** Whether the requested folder/project was selected. */
  folderSelected?: boolean;
}

export interface AntigravityRunOptions {
  /** Which junior to drive: 'A' = Antigravity IDE, 'B' = Antigravity 2.0. */
  junior?: string;
  /** Explicit CDP port override (defaults to the junior's configured port). */
  port?: number;
  /** Inactivity (stall) window in ms — NOT a cap on total work time. The agent
   *  may work arbitrarily long as long as it keeps making progress. */
  stallMs?: number;
  /** Model to select in the GUI picker before sending the prompt. */
  model?: string;
  /** Folder/project to select in the GUI before sending the prompt. */
  folder?: string;
  /** Require that `folder` was actually selected. `selectFolder` only clicks an
   *  ALREADY-OPEN project entry — it cannot OPEN a new path — so a fresh worktree
   *  the IDE has never opened will NOT be selected (verified live: a brand-new
   *  `.bureau-worktrees/<id>` matches no sidebar control). For delivery dispatches
   *  the junior MUST land in the worktree, so pass this to make a miss a hard
   *  failure instead of silently working in whatever folder is currently open. */
  requireFolder?: boolean;
  /** Start a fresh conversation first so a prior task can't bleed in. Default
   *  true; enforced strictly — if the fresh-conversation control can't be found
   *  we fail rather than risk reviewing stale context. */
  freshConversation?: boolean;
  /** Cancellation (job timeout / runner shutdown), honored every poll. */
  signal?: AbortSignal;
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
      if (opts.signal?.aborted) throw new HarnessError(`${cfg.label} dispatch aborted before attach`);
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
      // Wait for the Agent panel + chat input to actually be mounted before
      // driving it. A cold-launched workbench attaches before the panel renders;
      // proceeding into that gap is what stranded the first real task with
      // "could not start a fresh conversation … recalibrate the selector".
      const ready = await session.ensureChatInputReady();
      if (!ready) {
        throw new HarnessError(
          `${cfg.label}: Agent chat input ('${ANTIGRAVITY_INPUT_LABEL}') did not appear — the Agent ` +
            `panel may be unavailable in this build. Open it (Toggle Agent) and retry.`
        );
      }
      let model: string | undefined;
      let folderSelected: boolean | undefined;
      // Fresh conversation per task (unless disabled) prevents an earlier task's
      // plan/context from bleeding into this one — a real bug observed live.
      // Strict: a missing "New Conversation" control fails the run instead of
      // silently reviewing against unknown prior context.
      if (opts.freshConversation !== false) {
        const fresh = await session.newConversation();
        if (!fresh) {
          throw new HarnessError(
            `${cfg.label}: could not start a fresh conversation (no New Conversation/task/chat control). ` +
              `Refusing to continue in an unknown prior context — recalibrate the selector.`
          );
        }
        await new Promise(r => setTimeout(r, 800));
      }
      if (opts.folder) {
        folderSelected = await session.selectFolder(opts.folder);
        // `selectFolder` clicks an already-open project; it cannot OPEN a new path.
        // When the caller REQUIRES the folder (a delivery dispatch that must commit
        // in the task's worktree), a miss is a hard failure — never silently work
        // in the wrong, currently-open workspace and let that masquerade as the
        // task's output.
        if (opts.requireFolder && !folderSelected) {
          throw new HarnessError(
            `${cfg.label}: required folder '${opts.folder}' is not an open project in the IDE, and ` +
              `selectFolder cannot open a new path. Open that folder (the task's worktree) in the IDE ` +
              `first, or launch the junior on it — refusing to run in the wrong workspace.`
          );
        }
      }
      if (opts.model) model = await session.selectModel(opts.model);

      await session.sendPrompt(prompt);
      // Wait adaptively: keep extending while the junior is working; no hard cap.
      // A stall/abort/timeout is a hard failure — the partial transcript is
      // never returned as if it were a completed answer.
      const waited = await session.waitForCompletion({
        stallMs: opts.stallMs ?? 120000,
        signal: opts.signal
      });
      ensureCompleted(waited, `${cfg.label} junior`);

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
