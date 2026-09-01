import { ensureCompleted } from './agent-wait.ts';
import {
  ANTIGRAVITY_DEFAULT_PORT,
  ANTIGRAVITY_INPUT_LABEL,
  JUNIOR_COMPLETION_MARKER,
  juniorCompletionEvidence,
  MAIN_WINDOW_ATTACH_MS,
  AntigravitySession,
  ensureAntigravityRunning,
  ensureJuniorRunning,
  ensureFolderWindowWs,
  closeFolderWindow,
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
  /** The junior MUST run in `folder` (a delivery dispatch that has to commit in
   *  the task's worktree). Because `selectFolder` only clicks an ALREADY-OPEN
   *  project and cannot open a fresh path (verified live: a brand-new
   *  `.bureau-worktrees/<id>` matches no sidebar control), setting this makes
   *  `runCommand` OPEN — or reuse — a dedicated IDE window ON that folder and drive
   *  the junior there. If the window can't be opened it fails hard, never falling
   *  back to the wrong workspace. */
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

    // Choose which IDE WINDOW to drive. For a REQUIRED folder (a delivery dispatch
    // that must land in the task's worktree), open — or reuse — a dedicated window
    // ON that folder and drive the junior THERE. `selectFolder` alone cannot open a
    // fresh worktree (verified live), so this is what actually points the junior at
    // the worktree; a failure to open it is a hard failure (never run in the wrong
    // workspace). Otherwise drive the main workbench window as before.
    let wsUrl = '';
    let openedFolderWindow = false;
    if (opts.folder && opts.requireFolder) {
      wsUrl = await ensureFolderWindowWs(cfg, opts.folder, port, { signal: opts.signal });
      openedFolderWindow = true;
    } else {
      // The workbench window can lag the CDP endpoint SUBSTANTIALLY on a cold
      // launch — this Antigravity build (a VS Code fork) answers its debug port
      // within a second or two but does not expose an attachable workbench target
      // for another 30-40s. Poll on a generous time budget (not a fixed 20
      // iterations) so a slow cold start attaches instead of being misread as a
      // wedge. Honors the signal (job timeout / shutdown) every poll.
      const attachDeadline = Date.now() + MAIN_WINDOW_ATTACH_MS;
      while (Date.now() < attachDeadline) {
        if (opts.signal?.aborted) throw new HarnessError(`${cfg.label} dispatch aborted before attach`);
        try {
          wsUrl = await findMainWindowWs(port);
          if (wsUrl) break;
        } catch {
          // workbench not up yet — keep polling until the budget runs out
        }
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
      if (openedFolderWindow) {
        // We are already attached to a window opened ON the required folder — the
        // window IS the workspace, so there is nothing to select.
        folderSelected = true;
      } else if (opts.folder) {
        // Best-effort switch among already-open projects (no worktree involved).
        folderSelected = await session.selectFolder(opts.folder);
      }
      if (opts.model) model = await session.selectModel(opts.model);

      await session.sendPrompt(prompt);
      // N0 completion gate: when the prompt carries the sentinel instruction
      // (all department-built junior prompts do), completion requires idle+
      // stable AND the marker in the reply region — an agent that ends its turn
      // while its own subprocess runs is idle+stable but NOT done. Prompts
      // without the sentinel (arbitrary CLI commands) keep the old behavior.
      // Evidence is LINE-AWARE (`sliceAfterPrompt`-keyed, via
      // juniorCompletionEvidence): a whole-prompt needle match can never hit a
      // single transcript line and would fall back to the page tail — the
      // echoed prompt — whose instruction block contains the marker (senior
      // REVISE round 1).
      const markerGate = prompt.includes(JUNIOR_COMPLETION_MARKER)
        ? {
            completionEvidence: async () =>
              juniorCompletionEvidence(await session.readTranscript(250), prompt)
          }
        : {};
      // Wait adaptively: keep extending while the junior is working; no hard cap.
      // A stall/abort/timeout is a hard failure — the partial transcript is
      // never returned as if it were a completed answer.
      const waited = await session.waitForCompletion({
        stallMs: opts.stallMs ?? 120000,
        signal: opts.signal,
        ...markerGate
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
      // Close a per-task worktree window we opened so windows don't accumulate as
      // tasks complete (and worktrees get pruned post-merge). Best-effort; never
      // masks the primary outcome.
      if (openedFolderWindow && opts.folder) {
        await closeFolderWindow(opts.folder, port).catch(() => {});
      }
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
