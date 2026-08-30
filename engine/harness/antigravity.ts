import child_process from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.ts';
import { AGENT_PROGRESS_LABEL_RE, waitForAgentIdle, type AgentActivity, type WaitOptions, type WaitResult } from './agent-wait.ts';
import { killProcessesByImageName, processImageName } from './process-control.ts';

/**
 * Antigravity IDE integration — "run the junior with code."
 *
 * The junior of this department is the Antigravity IDE agent. This module lets
 * the department drive it programmatically: detect whether an Antigravity
 * instance is already exposing a CDP debugging endpoint, launch one with the
 * debug port if not, attach to its main window, and type/submit a command into
 * the agent chat — then read the transcript back.
 *
 * Antigravity is Electron/Chromium, so it speaks the Chrome DevTools Protocol
 * exactly like the browser the Phase 3 CdpIdeDriver already drives. Verified
 * live against Antigravity 2.8.1 (Electron 41 / Chrome 146).
 */

export const ANTIGRAVITY_DEFAULT_PORT = 9333;
/**
 * How long to wait for the MAIN workbench window to become attachable after its
 * CDP debug port starts answering. A cold-launched Antigravity (a VS Code fork)
 * answers `/json/version` within a second or two but does not expose an
 * attachable workbench `page` target on `/json/list` for another 30-40s. The old
 * fixed 20×1s (=20s) loop expired inside that gap on a cold start and reported
 * the instance as wedged — killing a healthy-but-slow IDE and re-racing its even
 * slower relaunch. 60s comfortably covers the observed cold-start render.
 */
export const MAIN_WINDOW_ATTACH_MS = 60000;
/** aria-label / placeholder of the agent chat input (calibrated against 2.8.1). */
export const ANTIGRAVITY_INPUT_LABEL = 'Message input';
/**
 * The main IDE workbench is served over https from loopback; the loading
 * splash is a `data:` URL. Match on the workbench URL, since the page title
 * changes to reflect the active chat/workspace.
 */
export const ANTIGRAVITY_WORKBENCH_URL_PREFIX = 'https://127.0.0.1';

/** Locate the Antigravity executable. Honors ANTIGRAVITY_PATH. */
export function findAntigravityBinary(): string {
  if (process.env.ANTIGRAVITY_PATH && fs.existsSync(process.env.ANTIGRAVITY_PATH)) {
    return process.env.ANTIGRAVITY_PATH;
  }
  const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  const candidates =
    os.platform() === 'win32'
      ? [
          path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'),
          path.join(local, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe')
        ]
      : os.platform() === 'darwin'
        ? ['/Applications/Antigravity.app/Contents/MacOS/Antigravity']
        : ['/usr/bin/antigravity', '/opt/Antigravity/antigravity'];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new HarnessError(
    'Antigravity executable not found. Set ANTIGRAVITY_PATH to the Antigravity binary.'
  );
}

/** CDP launch args: expose the DevTools endpoint on a fixed port. */
export function buildAntigravityArgs(port: number): string[] {
  return [`--remote-debugging-port=${port}`];
}

/**
 * The department runs TWO Antigravity juniors, one per Pro account:
 *
 *  - **A** — the Antigravity IDE (VS Code fork, `Antigravity IDE.exe`).
 *  - **B** — Antigravity 2.0, the standalone agent app (`Antigravity.exe`, ships
 *    `language_server.exe` + `webm_encoder.exe` for walkthrough recording).
 *
 * Both are Electron/Chromium and — verified live against 2.8.1 — share the same
 * DOM landmarks: the chat input is a `contenteditable` `aria-label="Message input"`,
 * the model picker is `button[aria-label^="Select model"]` opening `[role=menuitem]`
 * options, and the send control is `aria-label="Send message"`. They differ only
 * in binary, CDP port, and the env var that overrides the binary path.
 */
export interface JuniorConfig {
  /** Stable id used across the department ('A' | 'B'). */
  id: string;
  /** Human label for logs/journal. */
  label: string;
  /** Env var that, if set to an existing path, overrides the binary. */
  envPath: string;
  /** Absolute exe candidates, most-preferred first. */
  binaryCandidates: string[];
  /** CDP debug port this junior is launched/attached on. */
  cdpPort: number;
}

function localAppData(): string {
  return process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
}

/** The two juniors, keyed by id. */
export const JUNIORS: Record<string, JuniorConfig> = {
  A: {
    id: 'A',
    label: 'Antigravity IDE',
    envPath: 'ANTIGRAVITY_IDE_PATH',
    binaryCandidates:
      os.platform() === 'win32'
        ? [path.join(localAppData(), 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe')]
        : os.platform() === 'darwin'
          ? ['/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE']
          : ['/usr/bin/antigravity-ide', '/opt/Antigravity IDE/antigravity-ide'],
    cdpPort: 9333
  },
  B: {
    id: 'B',
    label: 'Antigravity 2.0',
    envPath: 'ANTIGRAVITY_2_PATH',
    binaryCandidates:
      os.platform() === 'win32'
        ? [path.join(localAppData(), 'Programs', 'Antigravity', 'Antigravity.exe')]
        : os.platform() === 'darwin'
          ? ['/Applications/Antigravity.app/Contents/MacOS/Antigravity']
          : ['/usr/bin/antigravity', '/opt/Antigravity/antigravity'],
    cdpPort: 9334
  }
};

/**
 * Assign exactly ONE junior to a task. A task must never activate both juniors —
 * two juniors exist for **parallelism** (different tasks at the same time), not to
 * double up on one task. The mapping is deterministic by task id (so the same task
 * always routes to the same junior, and re-runs are stable) and spreads different
 * tasks across A/B. Force one with `prefer`, or globally with env `JUNIOR_DEFAULT`.
 */
export function assignJunior(opts: { taskId: string; prefer?: string }): string {
  if (opts.prefer) return resolveJunior(opts.prefer).id;
  const forced = process.env['JUNIOR_DEFAULT'];
  if (forced) return resolveJunior(forced).id;
  // Deterministic hash of the task id → A or B.
  let h = 0;
  for (const ch of opts.taskId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 2 === 0 ? 'A' : 'B';
}

/** Resolve a junior config by id (case-insensitive), defaulting to A. */
export function resolveJunior(id?: string): JuniorConfig {
  const key = (id || 'A').toUpperCase();
  const cfg = JUNIORS[key];
  if (!cfg) {
    throw new HarnessError(`Unknown junior '${id}'. Known juniors: ${Object.keys(JUNIORS).join(', ')}.`);
  }
  return cfg;
}

/** Locate a specific junior's executable, honoring its env override. */
export function findJuniorBinary(cfg: JuniorConfig): string {
  const override = process.env[cfg.envPath];
  if (override && fs.existsSync(override)) return override;
  for (const c of cfg.binaryCandidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new HarnessError(
    `${cfg.label} executable not found. Set ${cfg.envPath} to its binary (looked in: ${cfg.binaryCandidates.join(', ')}).`
  );
}

/**
 * "See if this junior is open, or open it" — the per-junior analogue of
 * ensureAntigravityRunning. Reuses a live CDP endpoint on the junior's port,
 * else launches its binary with the debug port and waits for CDP.
 */
export async function ensureJuniorRunning(
  cfg: JuniorConfig,
  opts: { timeoutMs?: number } = {}
): Promise<EnsureResult> {
  const port = cfg.cdpPort;
  if (await isDebugPortLive(port)) return { launched: false, port };
  const binary = findJuniorBinary(cfg);
  const child = child_process.spawn(binary, buildAntigravityArgs(port), {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    if (await isDebugPortLive(port)) return { launched: true, port, child };
    await new Promise(r => setTimeout(r, 500));
  }
  throw new HarnessError(`${cfg.label} launched but no CDP endpoint on port ${port} within timeout`);
}

// ---------------------------------------------------------------------------
// Wedged-junior recovery: the port answers but the GUI never comes up
// ---------------------------------------------------------------------------

/** The junior app's process-image name (what taskkill /IM wants). Pure. */
export function juniorProcessImageName(cfg: JuniorConfig): string {
  const override = process.env[cfg.envPath];
  return processImageName(override || cfg.binaryCandidates.find(c => path.isAbsolute(c)) || cfg.binaryCandidates[0] || cfg.id);
}

/**
 * Best-effort: kill every running process of the junior's app — needed before a
 * recovery relaunch because Electron keeps tray/helper processes that hold the
 * single-instance handshake. Never throws ("not found" is a fine outcome).
 */
export async function killJuniorProcesses(cfg: JuniorConfig): Promise<void> {
  await killProcessesByImageName(juniorProcessImageName(cfg));
}

export interface JuniorRecoveryDeps {
  isPortLive?: (port: number) => Promise<boolean>;
  killProcesses?: (cfg: JuniorConfig) => Promise<void>;
  spawn?: (binary: string, args: string[]) => child_process.ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  /** Optional: once the port answers, wait for the MAIN workbench window to
   *  become attachable before returning. Injected in production with
   *  `findMainWindowWs`; left undefined in unit tests so recovery stays a pure
   *  kill+relaunch+port-wait there. Returns the window ws URL, or '' if not up. */
  findWindow?: (port: number) => Promise<string>;
}

/**
 * FORCED clean relaunch of a junior. Scar (dead job 8c6f373e, 2026-08-28): a
 * WEDGED instance answers the CDP port but never opens a usable window —
 * "opened a window … but no CDP window titled '<taskId> - Antigravity IDE'
 * appeared within timeout" — and `ensureJuniorRunning` no-ops on a live port,
 * so nothing ever fixed it and the dispatch burned all attempts against the
 * same dead instance. This always kills the app's processes and relaunches it
 * with the debug port, then waits for CDP. Throws if the endpoint never comes
 * up.
 */
export async function recoverJuniorRunning(
  cfg: JuniorConfig,
  opts: { timeoutMs?: number; windowTimeoutMs?: number; deps?: JuniorRecoveryDeps } = {}
): Promise<EnsureResult> {
  const port = cfg.cdpPort;
  const deps = {
    isPortLive: opts.deps?.isPortLive ?? isDebugPortLive,
    killProcesses: opts.deps?.killProcesses ?? killJuniorProcesses,
    spawn:
      opts.deps?.spawn ??
      ((binary: string, args: string[]) => child_process.spawn(binary, args, { detached: true, stdio: 'ignore' })),
    sleep: opts.deps?.sleep ?? (async (ms: number) => new Promise<void>(r => setTimeout(r, ms))),
    findWindow: opts.deps?.findWindow
  };
  // Unconditional: a wedged instance has a LIVE port, so reuse is exactly wrong.
  await deps.killProcesses(cfg);
  const binary = findJuniorBinary(cfg);
  const child = deps.spawn(binary, buildAntigravityArgs(port));
  child.unref?.();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  let portLive = false;
  while (Date.now() < deadline) {
    if (await deps.isPortLive(port)) {
      portLive = true;
      break;
    }
    await deps.sleep(500);
  }
  if (!portLive) {
    throw new HarnessError(
      `${cfg.label}: forced relaunch did not bring up a CDP endpoint on port ${port} within ` +
        `${Math.round(timeoutMs / 1000)}s — the installation may be broken or the port blocked.`
    );
  }
  // The port answers within a second or two, but a freshly relaunched workbench
  // (a VS Code fork) is not attachable for another 20-40s. When a window finder
  // is provided, wait for the MAIN workbench to actually appear before returning,
  // so the caller's immediate re-attempt attaches instead of racing the cold
  // render — the exact loop that burned both attempts on the wedge this recovery
  // exists to cure. Best-effort: if the window never renders inside the budget we
  // still return, and the caller's own (now generous) attach loop gets the last word.
  if (deps.findWindow) {
    const windowDeadline = Date.now() + (opts.windowTimeoutMs ?? MAIN_WINDOW_ATTACH_MS);
    while (Date.now() < windowDeadline) {
      try {
        const ws = await deps.findWindow(port);
        if (ws) break;
      } catch {
        // workbench not attachable yet — keep polling until the budget runs out
      }
      await deps.sleep(1000);
    }
  }
  return { launched: true, port, child };
}

/**
 * Match the "wedged GUI" failure shape: the junior's CDP port answered, a
 * window/workbench was asked for, but no usable window ever appeared. Pure —
 * keyed off the exact `ensureFolderWindowWs` / main-window-attach messages so
 * ordinary agent/calibration errors never trigger a relaunch.
 */
export function isJuniorWedgedWindowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /no CDP window titled .+ appeared within timeout/i.test(msg) ||
    /workbench (?:window did not become available|did not become available)/i.test(msg)
  );
}

function cdpGet(port: number, urlPath: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('cdp http timeout')));
  });
}

/** True if an Antigravity (or any Chromium) CDP endpoint is live on the port. */
export async function isDebugPortLive(port: number = ANTIGRAVITY_DEFAULT_PORT): Promise<boolean> {
  try {
    const v = await cdpGet(port, '/json/version');
    return typeof v?.webSocketDebuggerUrl === 'string';
  } catch {
    return false;
  }
}

export interface EnsureResult {
  launched: boolean;
  port: number;
  child?: child_process.ChildProcess;
}

/**
 * "See if Antigravity is open, or open it." If a CDP endpoint is already live
 * on the port, reuse it; otherwise launch Antigravity with the debug port and
 * wait until CDP answers.
 */
export async function ensureAntigravityRunning(
  port: number = ANTIGRAVITY_DEFAULT_PORT,
  opts: { timeoutMs?: number } = {}
): Promise<EnsureResult> {
  if (await isDebugPortLive(port)) {
    return { launched: false, port };
  }
  const binary = findAntigravityBinary();
  const child = child_process.spawn(binary, buildAntigravityArgs(port), {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    if (await isDebugPortLive(port)) return { launched: true, port, child };
    await new Promise(r => setTimeout(r, 500));
  }
  throw new HarnessError(`Antigravity launched but no CDP endpoint on port ${port} within timeout`);
}

/** The window basename normalizer + title matcher used by both the folder-window
 *  finder and the main-window exclusion, so they agree on identity. Antigravity
 *  (a VS Code fork) titles each window `"<folder-basename> - Antigravity IDE"`
 *  (verified live). */
function folderWindowBase(folderPath: string): string {
  return path.basename(folderPath.replace(/[/\\]+$/, ''));
}
function titleMatchesBase(title: string, base: string): boolean {
  if (!base) return false;
  return title === `${base} - Antigravity IDE` || title.startsWith(`${base} - `) || title === base;
}

/**
 * Basenames of worktree windows THIS process has opened via `ensureFolderWindowWs`
 * and not yet closed. `findMainWindowWs` excludes them so, once one or more
 * per-task worktree windows are open, a plan-authoring dispatch (which drives the
 * MAIN workbench, not a worktree) can never be attached to a worktree window by
 * the URL-prefix heuristic — the two are otherwise indistinguishable by URL.
 */
const OPEN_WORKTREE_WINDOWS = new Set<string>();

/** Pick the MAIN workbench window from a CDP target array, EXCLUDING any worktree
 *  windows we opened (`excludeBases`). Pure/deterministic for unit tests. */
export function pickMainWindow(targets: any[], excludeBases: Iterable<string> = []): string {
  const bases = [...excludeBases];
  const isWorktreeWin = (t: any) =>
    typeof t.title === 'string' && bases.some(b => titleMatchesBase(t.title, b));
  const pages = (targets as any[]).filter(
    t => t && t.type === 'page' && t.webSocketDebuggerUrl && !isWorktreeWin(t)
  );
  const page =
    pages.find(t => typeof t.url === 'string' && t.url.startsWith(ANTIGRAVITY_WORKBENCH_URL_PREFIX)) ??
    pages.find(t => typeof t.url === 'string' && t.url.startsWith('vscode-file://')) ??
    pages.find(t => typeof t.url === 'string' && !t.url.startsWith('data:'));
  return page ? page.webSocketDebuggerUrl : '';
}

/** Find the main IDE window's WebSocket debugger URL (not the loading splash, and
 *  never a per-task worktree window this process opened). */
export async function findMainWindowWs(port: number = ANTIGRAVITY_DEFAULT_PORT): Promise<string> {
  const targets = await cdpGet(port, '/json/list');
  const ws = pickMainWindow(targets as any[], OPEN_WORKTREE_WINDOWS);
  if (!ws) {
    throw new HarnessError(
      `Main Antigravity window not found on port ${port} (still loading?). Retry shortly.`
    );
  }
  return ws;
}

/**
 * Pick, from a CDP `/json/list` target array, the workbench window opened ON a
 * given folder — matched by the `"<folder-basename> - Antigravity IDE"` title
 * (verified live), unique per task. Pure/deterministic (unit-tested). Returns the
 * window's `webSocketDebuggerUrl`, or '' if none matches (e.g. still loading, its
 * title not populated yet).
 */
export function pickFolderWindow(targets: any[], folderPath: string): string {
  const base = folderWindowBase(folderPath);
  if (!base) return '';
  const pages = (targets as any[]).filter(
    t => t && t.type === 'page' && t.webSocketDebuggerUrl && typeof t.title === 'string'
  );
  const hit =
    pages.find(t => t.title === `${base} - Antigravity IDE`) ??
    pages.find(t => t.title.startsWith(`${base} - `)) ??
    pages.find(t => t.title === base);
  return hit ? hit.webSocketDebuggerUrl : '';
}

/** Find the WebSocket URL of an already-open window on `folderPath`, or '' if
 *  none is open yet (see `pickFolderWindow`). */
export async function findFolderWindowWs(
  folderPath: string,
  port: number = ANTIGRAVITY_DEFAULT_PORT
): Promise<string> {
  const targets = await cdpGet(port, '/json/list');
  return pickFolderWindow(targets as any[], folderPath);
}

/** Best-effort: close the IDE window opened on `folderPath` (frees the per-task
 *  worktree window so windows don't accumulate as tasks complete / worktrees are
 *  pruned) and stop excluding it in `findMainWindowWs`. Never throws. */
export async function closeFolderWindow(
  folderPath: string,
  port: number = ANTIGRAVITY_DEFAULT_PORT
): Promise<void> {
  const base = folderWindowBase(folderPath);
  try {
    const targets = await cdpGet(port, '/json/list');
    const win = (targets as any[]).find(
      t => t && t.type === 'page' && t.id && typeof t.title === 'string' && titleMatchesBase(t.title, base)
    );
    if (win) {
      // /json/close returns plain text ("Target is closing"), not JSON — fire and
      // forget with a raw GET so cdpGet's JSON.parse can't reject.
      await new Promise<void>(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/json/close/${win.id}`, res => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.setTimeout(2000, () => req.destroy());
      });
    }
  } catch {
    /* best-effort */
  } finally {
    OPEN_WORKTREE_WINDOWS.delete(base);
  }
}

/**
 * Ensure a dedicated Antigravity window is open ON `folderPath` and return its
 * CDP WebSocket URL — the mechanism that actually lets the department point a
 * junior at a fresh bureau worktree. `selectFolder` only clicks an ALREADY-open
 * project and cannot open a new path (verified live), so for delivery we OPEN the
 * worktree in its own window: `Antigravity IDE.exe --new-window <folder>` reuses
 * the running instance (single-instance) and adds a window on that folder, which
 * surfaces on the same CDP debug port with title `"<basename> - Antigravity IDE"`
 * (verified live). Reuses a window already open on the folder; otherwise launches
 * one and polls until its titled target appears. Honors `opts.signal` every poll
 * (job timeout / shutdown), matching the main-window attach path. The caller must
 * have ensured the instance is running with the debug port first.
 */
export async function ensureFolderWindowWs(
  cfg: JuniorConfig,
  folderPath: string,
  port: number = ANTIGRAVITY_DEFAULT_PORT,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const base = folderWindowBase(folderPath);
  const existing = await findFolderWindowWs(folderPath, port);
  if (existing) {
    OPEN_WORKTREE_WINDOWS.add(base);
    return existing;
  }
  const binary = findJuniorBinary(cfg);
  const child = child_process.spawn(binary, ['--new-window', folderPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new HarnessError(`${cfg.label}: aborted while opening a window on '${folderPath}'.`);
    }
    const ws = await findFolderWindowWs(folderPath, port);
    if (ws) {
      OPEN_WORKTREE_WINDOWS.add(base);
      return ws;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new HarnessError(
    `${cfg.label}: opened a window on '${folderPath}' but no CDP window titled ` +
      `'${base} - Antigravity IDE' appeared within timeout.`
  );
}

/** Lines that are IDE chrome, not conversation content. */
const CHROME_PATTERNS: RegExp[] = [
  /Ask anything/i,
  /^(Gemini|Claude|GPT-OSS|GPT|Gemma|Deep Research|Lyria|Nano)/i,
  /^(Medium|Fast|Low|High|Thinking)$/i,
  /View Usage/i,
  /^Open IDE$/i,
  /No more older messages/i,
  /^\d{1,2}:\d{2}\s?(AM|PM)$/i // bare timestamps
];

function isChrome(line: string): boolean {
  return CHROME_PATTERNS.some(p => p.test(line.trim()));
}

/** Bare timestamps are weak chrome: they can appear MID-message (long generations
 *  crossing a minute boundary), so they must not terminate an extracted block. */
function isTimestamp(line: string): boolean {
  return /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(line.trim());
}

/**
 * Isolate the agent's reply from a full conversation-text capture, version-
 * resiliently: take the content that appears AFTER the last occurrence of the
 * prompt we sent, dropping bare timestamps and trailing IDE chrome (input
 * placeholder, model-name label, effort toggles, "View Usage", etc.). Falls
 * back to the last non-chrome lines when the prompt is not located.
 *
 * Pure and deterministic — unit-tested against captured Antigravity 2.8.1 text.
 */
export function extractAgentReply(fullText: string, prompt: string): string {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
  const needle = prompt.trim();
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === needle || lines[i].includes(needle)) {
      start = i + 1;
      break;
    }
  }
  const after = start >= 0 ? lines.slice(start) : lines.slice(-12);
  const reply: string[] = [];
  for (const line of after) {
    if (isChrome(line)) {
      // Stop at the first chrome marker once we've collected some reply;
      // otherwise skip leading timestamps/labels.
      if (reply.length > 0) break;
      continue;
    }
    if (line === needle) continue; // skip an echoed prompt
    reply.push(line);
  }
  return reply.join('\n').trim();
}

/**
 * Antigravity produces two named artifacts the Senior must review: an
 * **implementation plan** (emitted before it codes) and a **walkthrough**
 * (emitted when work is done). These extractors isolate those blocks from a
 * full-conversation capture, marker-based and version-resilient like
 * `extractAgentReply` — they key off heading text, not fragile DOM classes.
 *
 * NOTE: the exact heading strings are calibrated on the first live task that
 * emits a plan/walkthrough; `PLAN_MARKERS` / `WALKTHROUGH_MARKERS` are the one
 * place to re-tune. Until then they match the common Antigravity headings.
 */
export const PLAN_MARKERS: RegExp[] = [
  /^(implementation plan|the plan|here'?s (the|my) plan|plan:)/i,
  /^#{1,3}\s*(implementation\s+plan|the\s+plan|plan)\b/i
];
export const WALKTHROUGH_MARKERS: RegExp[] = [
  /^(walkthrough|summary of changes|here'?s what i (did|changed|built)|changes made)/i,
  /^#{1,3}\s*(walkthrough|summary)\b/i
];

/** Extract the block that starts at the first line matching any marker.
 *  Terminates at real IDE chrome (a new message's chrome), but tolerates bare
 *  timestamps inside the block — a long plan generation can cross a minute
 *  boundary and get stamped mid-plan. */
function extractMarkedBlock(fullText: string, markers: RegExp[]): string {
  const lines = fullText.split('\n').map(l => l.replace(/\s+$/, ''));
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && markers.some(m => m.test(t))) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (i > start && isTimestamp(t)) continue; // mid-block stamp: skip, keep going
    if (i > start && isChrome(t)) break;
    if (t) block.push(t);
  }
  return block.join('\n').trim();
}

/** The implementation plan Antigravity emits before coding (best-effort). */
export function extractPlan(fullText: string): string {
  return extractMarkedBlock(fullText, PLAN_MARKERS);
}

/** The walkthrough Antigravity emits when work is done (best-effort). */
export function extractWalkthrough(fullText: string): string {
  return extractMarkedBlock(fullText, WALKTHROUGH_MARKERS);
}

/**
 * Isolate the region of the transcript AFTER the current prompt, so plan/
 * walkthrough extraction reads the *current* reply and not stale history from an
 * earlier task in the same conversation. Keys off the last line of the prompt
 * (robust to multi-line prompts); falls back to the whole text if not found.
 */
export function sliceAfterPrompt(fullText: string, prompt: string): string {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
  const pLines = prompt.split('\n').map(l => l.trim()).filter(Boolean);
  const lastPromptLine = pLines[pLines.length - 1];
  if (!lastPromptLine) return fullText;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === lastPromptLine || lines[i].includes(lastPromptLine)) {
      return lines.slice(i + 1).join('\n');
    }
  }
  return fullText;
}

/** Everything the junior produced, plus the isolated reply/plan/walkthrough. */
export interface JuniorArtifacts {
  /** Full visible conversation capture (the whole output). */
  transcript: string;
  /** The agent's reply to the sent prompt, chrome-stripped. */
  reply: string;
  /** Implementation plan block, if present. */
  plan: string;
  /** Walkthrough block, if present. */
  walkthrough: string;
}

/** Minimal CDP session over the built-in WebSocket. */
export class AntigravitySession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readonly wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new HarnessError('CDP WebSocket connection failed'));
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse((ev as MessageEvent).data as string);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new HarnessError(`CDP error: ${msg.error.message}`)) : p.resolve(msg.result);
      }
    });
    await this.send('Runtime.enable');
  }

  send(method: string, params: any = {}, timeoutMs = 20000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new HarnessError(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  private async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  }

  private async pressKey(
    key: string,
    code: string,
    vk: number,
    mods: { ctrl?: boolean } = {}
  ): Promise<void> {
    // CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
    const modifiers = mods.ctrl ? 2 : 0;
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      });
    }
  }

  /**
   * Ensure the Agent (Cascade) panel is open and its chat input is rendered
   * BEFORE we try to drive it. On a cold launch the workbench window attaches a
   * beat before the agent panel mounts, so the input ('Message input') is briefly
   * absent — the harness used to call newConversation()/sendPrompt() into that gap
   * and hard-fail ("could not start a fresh conversation … recalibrate the
   * selector"), which is exactly what stranded the first real task. Poll for the
   * input; if it does not appear promptly and the Agent toggle is not already
   * active, click it once to open the panel, then keep polling. Returns true once
   * the input is present, false on timeout.
   */
  async ensureChatInputReady(timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const label = JSON.stringify(ANTIGRAVITY_INPUT_LABEL);
    let triedToggle = false;
    const inputPresent = () =>
      this.evaluate(
        `(() => !![...document.querySelectorAll('[contenteditable="true"],textarea,[role=combobox]')]` +
          `.find(e => (e.getAttribute('aria-label') || e.getAttribute('placeholder')) === ${label}))()`
      );
    while (Date.now() < deadline) {
      if (await inputPresent()) return true;
      // First miss only: open the Agent panel if its toggle is not already active.
      // Guarded on the toggle's "checked" state so we never CLOSE an open panel
      // (the input may simply not have mounted yet — for that we just keep polling).
      if (!triedToggle) {
        triedToggle = true;
        await this.evaluate(`(() => {
          const t = [...document.querySelectorAll('a,button,[role=button]')]
            .find(e => /toggle agent/i.test(e.getAttribute('aria-label') || ''))
            || document.querySelector('.codicon-layout-sidebar-right');
          if (t && !/\\bchecked\\b/.test((t.className || '').toString())) { t.click(); return true; }
          return false;
        })()`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * Start a fresh conversation so an earlier task's context/plan can't bleed into
   * this one. Prefers the Antigravity IDE's explicit new-conversation control
   * (a stable `data-tooltip-id="new-conversation-tooltip"` header icon, verified
   * live); falls back to a labelled control, then to proving the panel is already
   * empty.
   */
  async newConversation(): Promise<boolean> {
    await this.pressKey('Escape', 'Escape', 27);
    return !!(await this.evaluate(`(() => {
      // 0. Antigravity IDE (Junior A) exposes its new-conversation control as an
      // unlabelled panel-header icon carrying a STABLE data attribute
      // (data-tooltip-id="new-conversation-tooltip") — verified live. Prefer it:
      // it starts a genuinely fresh conversation even when a prior one exists, so
      // we no longer depend on the emptiness heuristic below.
      const explicit = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
      if (explicit) { explicit.click(); return true; }

      // 1. Explicit "start fresh" control by accessible name. The label varies
      // across Antigravity versions and between the two juniors ("New
      // Conversation", "New chat", "New task", "New Cascade", "New thread"),
      // sometimes suffixed with a keybinding ("New Chat (Ctrl+L)") or exposed via
      // title/tooltip on a "+" button. Match on the accessible name (aria-label,
      // then title, then text): it must contain the word "new" AND a
      // conversation-ish noun, so an unrelated "new file"/"new terminal" is never
      // clicked.
      const INPUT = ${JSON.stringify(ANTIGRAVITY_INPUT_LABEL)};
      const name = x => ((x.getAttribute && (x.getAttribute('aria-label') || x.getAttribute('title'))) || x.innerText || '').trim();
      const wants = /\\bnew\\b/i;
      const noun = /(conversation|chat|task|cascade|thread)/i;
      const cands = [...document.querySelectorAll('button,[role=button],[role=menuitem],a')];
      const hit = cands.find(x => { const n = name(x); return wants.test(n) && noun.test(n); });
      if (hit) { hit.click(); return true; }

      // 2. Antigravity IDE (the VS Code fork, Junior A) renders the agent panel's
      // "new conversation" control as an UNLABELED header icon — no aria-label,
      // title, or text — so step 1 can never find it. Rather than fail hard (and
      // strand the task) or click a mislabeled control, fall back to proving the
      // conversation is ALREADY empty: a freshly opened panel has no prior turns,
      // so there is no stale task context to bleed in — exactly what the reset was
      // guarding against. Proceed only when that is verifiably true.
      const input = [...document.querySelectorAll('[contenteditable="true"],textarea')]
        .find(e => (e.getAttribute('aria-label') || e.getAttribute('placeholder')) === INPUT);
      if (!input) return false; // no chat at all — genuinely can't proceed
      // Scope the conversation area by GEOMETRY (DOM ancestry walks straight out
      // into the editor): it is the region directly ABOVE the input, in the same
      // right-hand column. A real prior conversation fills that region with
      // message bubbles; an empty one leaves it blank. Treat the panel as fresh
      // only when no substantial text block sits above the input in its column.
      const ir = input.getBoundingClientRect();
      const colLeft = ir.left - 24;
      const turns = [...document.querySelectorAll('div,p,article,li')].filter(e => {
        if (e === input || e.contains(input) || input.contains(e)) return false;
        const r = e.getBoundingClientRect();
        const inColumn = r.left >= colLeft && r.right <= ir.right + 24;
        const aboveInput = r.bottom <= ir.top && r.top >= 40; // below the titlebar
        return inColumn && aboveInput && (e.innerText || '').trim().length > 80;
      });
      return turns.length === 0;
    })()`));
  }

  /** Focus the agent chat input, type the command, and submit it — VERIFIED at
   *  both ends. A prompt that never lands in a real input, or is typed but never
   *  submitted, must fail loudly here: proceeding would wait against an unchanged
   *  screen and capture stale/empty content as if it were the agent's reply. We
   *  tag the focused element (`data-bureau-input`) so the insert/submit checks
   *  read back the SAME box, not some other editable on the page. */
  async sendPrompt(prompt: string): Promise<void> {
    // Dismiss any stray open menu (e.g. the model picker) so it can't swallow
    // focus or keystrokes, then land focus on the chat input.
    await this.pressKey('Escape', 'Escape', 27);
    const focused = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"],textarea')]
        .find(e => (e.getAttribute('aria-label')||e.getAttribute('placeholder')) === ${JSON.stringify(ANTIGRAVITY_INPUT_LABEL)});
      if (!el) return false; el.focus(); el.setAttribute('data-bureau-input', '1'); return true;
    })()`);
    if (!focused) throw new HarnessError(`Chat input ('${ANTIGRAVITY_INPUT_LABEL}') not found`);
    // Clear any stale draft with real key events (raw innerText='' is ignored by
    // the contenteditable framework and would leave the previous text to append).
    await this.pressKey('a', 'KeyA', 65, { ctrl: true });
    await this.pressKey('Delete', 'Delete', 46);
    await this.send('Input.insertText', { text: prompt });
    await new Promise(r => setTimeout(r, 300));
    // Verify the text actually landed in the box we focused before pressing Enter.
    const inserted = await this.evaluate(`(() => {
      const el = document.querySelector('[data-bureau-input="1"]');
      return !!el && (el.innerText||el.value||'').trim().length > 0;
    })()`);
    if (!inserted) {
      await this.evaluate(`(() => { const el = document.querySelector('[data-bureau-input="1"]'); if (el) el.removeAttribute('data-bureau-input'); })()`);
      throw new HarnessError(
        `The prompt did not land in the chat input ('${ANTIGRAVITY_INPUT_LABEL}') — focus was lost or the selector is stale.`
      );
    }
    await this.pressKey('Enter', 'Enter', 13);
    await new Promise(r => setTimeout(r, 400));
    // Antigravity 2.0 does not submit on Enter — it has an explicit "Send
    // message" control. If the input still holds our text, click Send. (The IDE
    // submits on Enter, so this is a no-op there because the box is empty.)
    await this.evaluate(`(() => {
      const input = document.querySelector('[data-bureau-input="1"]');
      const still = input && (input.innerText||input.value||'').trim().length > 0;
      if (!still) return 'sent-by-enter';
      const send = [...document.querySelectorAll('button,[role=button]')]
        .find(b => (b.getAttribute('aria-label')||'') === 'Send message');
      if (send) { send.click(); return 'sent-by-button'; }
      return 'unsent';
    })()`);
    await new Promise(r => setTimeout(r, 300));
    // Confirm the box cleared (submitted). An unsent prompt is a hard failure —
    // never wait against a still-full input as if the agent were replying.
    const submitted = await this.evaluate(`(() => {
      const el = document.querySelector('[data-bureau-input="1"]');
      const cleared = !el || (el.innerText||el.value||'').trim().length === 0;
      if (el) el.removeAttribute('data-bureau-input');
      return cleared;
    })()`);
    if (!submitted) {
      throw new HarnessError(
        `The prompt was typed but never submitted (Enter did not send and no 'Send message' control was found).`
      );
    }
  }

  /**
   * Drive the model picker: open `button[aria-label^="Select model"]`, then
   * click the `[role=menuitem]` whose text starts with `modelName`. Calibrated
   * live against 2.8.1 (options: "Gemini 3.7 Flash", "Claude Opus 4.6", …).
   * Returns the model label now shown on the picker button.
   */
  async selectModel(modelName: string): Promise<string> {
    await this.pressKey('Escape', 'Escape', 27);
    const opened = await this.evaluate(`(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
        .find(x => (x.getAttribute('aria-label')||'').startsWith('Select model'));
      if (!b) return false; b.click(); return true;
    })()`);
    if (!opened) throw new HarnessError('Model picker button ("Select model") not found');
    await new Promise(r => setTimeout(r, 500));
    const picked = await this.evaluate(`(() => {
      const want = ${JSON.stringify(modelName)}.toLowerCase();
      const items = [...document.querySelectorAll('[role=menuitem],[role=option]')];
      const hit = items.find(e => (e.innerText||'').trim().toLowerCase().startsWith(want))
        || items.find(e => (e.innerText||'').toLowerCase().includes(want));
      if (!hit) return false; hit.click(); return true;
    })()`);
    if (!picked) {
      await this.pressKey('Escape', 'Escape', 27);
      throw new HarnessError(`Model '${modelName}' not offered in the picker`);
    }
    await new Promise(r => setTimeout(r, 400));
    // Read back the current model from the picker's aria-label ("…current: X").
    const label = await this.evaluate(`(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
        .find(x => (x.getAttribute('aria-label')||'').startsWith('Select model'));
      return b ? (b.getAttribute('aria-label')||'').replace(/^Select model,?\\s*current:?\\s*/i,'').trim() : '';
    })()`);
    return label || modelName;
  }

  /**
   * Select the working folder / project. In both juniors the sidebar lists each
   * project as a button carrying its name (or absolute path) as text; clicking it
   * opens that workspace. Matching is tiered so an unrelated button that merely
   * CONTAINS the wanted text is only clicked when nothing closer exists: exact
   * name/path first, then prefix, then substring. Returns true if a matching
   * project was clicked.
   */
  async selectFolder(nameOrPath: string): Promise<boolean> {
    await this.pressKey('Escape', 'Escape', 27);
    return !!(await this.evaluate(`(() => {
      const want = ${JSON.stringify(nameOrPath)}.toLowerCase();
      const btns = [...document.querySelectorAll('button,[role=button],[role=treeitem],a')];
      const norm = e => (e.innerText||e.getAttribute('aria-label')||'').trim().toLowerCase();
      const hit = btns.find(e => norm(e) === want)
        || btns.find(e => norm(e).startsWith(want))
        || btns.find(e => norm(e).includes(want));
      if (!hit) return false; hit.click(); return true;
    })()`));
  }

  /** Capture the whole output plus the isolated reply, plan, and walkthrough. */
  async captureArtifacts(prompt: string, lastLines = 200): Promise<JuniorArtifacts> {
    const transcript = await this.readTranscript(lastLines);
    // Extract plan/walkthrough from the CURRENT reply region only, so an earlier
    // task's plan still in the conversation scroll can't be captured by mistake.
    const region = sliceAfterPrompt(transcript, prompt);
    return {
      transcript,
      reply: extractAgentReply(transcript, prompt),
      plan: extractPlan(region),
      walkthrough: extractWalkthrough(region)
    };
  }

  /** Probe the agent's current activity (working / idle / output length). */
  private async probeActivity(): Promise<AgentActivity> {
    return (await this.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button,[role=button]')];
      const has = re => btns.some(b => re.test(((b.getAttribute('aria-label')||b.innerText)||'').trim()));
      // A live progress indicator is a SMALL standalone status label ("Working",
      // "Generating…") — NOT the word buried in the agent's own reply prose (e.g.
      // "working tree clean"), which used to make the waiter believe the agent was
      // still generating forever. Match a leaf element whose ENTIRE text is a
      // progress word; Stop/Cancel stays the primary "actively generating" signal.
      const progressRe = new RegExp(${JSON.stringify(AGENT_PROGRESS_LABEL_RE.source)}, 'i');
      const statusWorking = [...document.querySelectorAll('span,div,p,button,[role=status],[aria-live]')]
        .some(e => e.children.length === 0 && progressRe.test((e.innerText||'').trim()));
      const working = has(/^(stop|cancel)$/i) || statusWorking;
      const canSend = has(/^send( message)?$/i);
      return { working, canSend, len: document.body.innerText.length };
    })()`)) as AgentActivity;
  }

  /**
   * Wait until the agent finishes — adaptively, with NO hard time cap: keep
   * waiting as long as it's working or still producing output, and only stop when
   * it's genuinely idle (done) or inactive for the stall window. See agent-wait.
   */
  async waitForCompletion(opts: WaitOptions = {}): Promise<WaitResult> {
    return waitForAgentIdle(() => this.probeActivity(), opts);
  }

  /** Raw visible-text capture (last N non-empty lines). */
  async readTranscript(lastLines = 40): Promise<string> {
    return (
      (await this.evaluate(
        `document.body.innerText.split('\\n').map(l=>l.trim()).filter(Boolean).slice(-${lastLines}).join('\\n')`
      )) || ''
    );
  }

  /** The agent's reply to a specific prompt, isolated from IDE chrome. */
  async readAgentReply(prompt: string): Promise<string> {
    const full = await this.readTranscript(60);
    return extractAgentReply(full, prompt);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
