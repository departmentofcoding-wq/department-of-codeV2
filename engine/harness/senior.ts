import child_process from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.ts';
import { sliceAfterPrompt } from './antigravity.ts';
import { AGENT_PROGRESS_LABEL_RE, ensureCompleted, waitForAgentIdle, type AgentActivity, type WaitOptions, type WaitResult } from './agent-wait.ts';
import { killProcessesByImageName, processImageName } from './process-control.ts';
import { makeInactivityGuard } from './inactivity-guard.ts';

/**
 * Senior review harness — "run the senior with code."
 *
 * The department's SENIORS do not write code; they **review** what a junior
 * produced — the implementation **plan** (before coding) and the **walkthrough**
 * (after) captured by the junior harness — and return a verdict. There are two:
 *
 *  - **claude** — the Claude Code CLI (`claude -p`, headless), authenticated
 *    against api.anthropic.com. Driven as a subprocess: prompt in, verdict out.
 *  - **zai** — ZCode, the Z.ai GLM desktop agent (Electron/Chromium, like the
 *    juniors). Driven over CDP: type the review into its chat, read the verdict.
 *
 * Both are hidden behind the `SeniorDriver` seam so the department flow calls one
 * abstraction, and tests inject fakes.
 */

export type Verdict = 'approve' | 'revise';

export interface SeniorReviewInput {
  /** What is being reviewed. */
  kind: 'plan' | 'walkthrough';
  /** Task title / spec for context (the senior reviews the artifact against it). */
  taskTitle: string;
  taskSpec?: string;
  /** The task's intent, verbatim — so the senior can judge plan↔task alignment. */
  taskIntent?: string;
  /** The task's acceptance criteria, verbatim. */
  taskAcceptance?: string;
  /** Optional project context. */
  projectName?: string;
  projectPath?: string;
  /** The junior's implementation plan text (required for kind='plan'). */
  plan?: string;
  /** The junior's walkthrough text (required for kind='walkthrough'). */
  walkthrough?: string;
  /** Model to review with. Claude: passed to `--model`. ZCode: driven in the GUI picker. */
  model?: string;
  /**
   * Whether this review starts a FRESH senior conversation (default true). The
   * first round of a task's review cycle starts fresh; subsequent rounds pass
   * false so the SAME senior conversation/window is reused — the reviewer keeps
   * the prior round's artifact and its own feedback in context, instead of a
   * cold new window each round (wasteful of both time and context). Mirrors the
   * junior side's freshConversation handling.
   */
  freshConversation?: boolean;
}

export interface SeniorVerdict {
  senior: string;
  verdict: Verdict;
  feedback: string;
  /** The raw text the senior produced, for the journal/audit. */
  raw: string;
  /** The model label actually in effect (CLI --model / GUI picker read-back),
   *  when known — used for honest attribution. */
  model?: string;
}

export interface SeniorDriver {
  review(input: SeniorReviewInput): Promise<SeniorVerdict>;
}

// ---------------------------------------------------------------------------
// Pure surface: prompt building + verdict parsing (unit-tested without a senior)
// ---------------------------------------------------------------------------

/** Build the review prompt. Seniors REVIEW; they must not write code. */
export function buildReviewPrompt(input: SeniorReviewInput): { system: string; user: string } {
  const artifactLabel = input.kind === 'plan' ? 'IMPLEMENTATION PLAN' : 'WALKTHROUGH';
  const artifact = (input.kind === 'plan' ? input.plan : input.walkthrough) ?? '';
  const system =
    'You are a Senior Engineer performing code review in a software bureau. ' +
    'You do NOT write code. You review the artifact a junior produced and judge it ' +
    'against the TASK below — check that the ' + input.kind + ' actually satisfies the ' +
    "task's intent and acceptance criteria, is correctly scoped (not missing work, not " +
    'over-engineered), and is sound. ' +
    'Your reply MUST begin with a line "VERDICT: APPROVE" or "VERDICT: REVISE"; ' +
    'after that line, reason as fully as the review needs — do not artificially ' +
    'shorten it — and give concrete required changes if REVISE.';
  // The task, verbatim, so the senior can review plan↔task alignment.
  const user =
    `===== TASK (verbatim) =====\n` +
    `TITLE: ${input.taskTitle}\n` +
    (input.projectName ? `PROJECT: ${input.projectName} (${input.projectPath ?? ''})\n` : '') +
    (input.taskIntent ? `INTENT: ${input.taskIntent}\n` : '') +
    (input.taskSpec ? `SPEC: ${input.taskSpec}\n` : '') +
    (input.taskAcceptance ? `ACCEPTANCE: ${input.taskAcceptance}\n` : '') +
    `\n===== JUNIOR'S ${artifactLabel} =====\n${artifact}\n\n` +
    `Review the ${input.kind} against the task above. Start with the VERDICT line.`;
  return { system, user };
}

/**
 * Parse a senior's free-text reply into a verdict. Keys off an explicit
 * "VERDICT: APPROVE/REVISE/…" line anywhere in the reply. Genuinely fail-closed:
 * with no explicit marker the verdict is ALWAYS 'revise' — there is no
 * approve-by-heuristic fallback, because prose like "I don't think this should
 * be approved as-is" pattern-matches approval language while meaning the
 * opposite. An unreadable or truncated review never auto-approves.
 */
export function parseVerdict(raw: string): { verdict: Verdict; feedback: string } {
  const text = (raw || '').trim();
  const feedback = text || 'No review text produced.';
  const marker = text.match(/VERDICT:\s*(APPROVE[D]?|REVISE|AMEND|REJECT)/i);
  if (marker) {
    return { verdict: /APPROVE/i.test(marker[1]) ? 'approve' : 'revise', feedback };
  }
  return { verdict: 'revise', feedback };
}

/**
 * Distinctive visible chrome of the CDP senior's EMPTY home screen — the
 * permission-mode controls that exist only before a conversation is started.
 * A real review reply never contains these standalone labels. Used to tell a
 * genuine (if verdict-less) review apart from a capture of the welcome screen.
 */
export const SENIOR_HOME_SCREEN_MARKERS: RegExp[] = [
  /\bAsk before changes\b/i,
  /\bEdit automatically\b/i,
  /\bPlan mode\b/i,
  /\bAdd context\b/i,
  /\bFull access\b/i
];

/**
 * Detect the failure mode that manufactured phantom REVISE loops: the harness
 * "completed" a review but actually captured the senior app's empty home screen
 * (permission toggles + template cards), never a review. `parseVerdict` then
 * fail-closes to REVISE with that chrome as "feedback", which the plan cycle
 * feeds back to the junior — re-dispatching the SAME task as if the senior had
 * asked for changes. Rather than record that, the caller throws so the round
 * FAILS loudly and surfaces to the operator.
 *
 * Conservative on purpose: only trips when MULTIPLE home-screen markers are
 * present AND there is no explicit VERDICT line, so a genuine review that merely
 * mentions "plan mode" once is never rejected. Returns a reason string when the
 * capture is not a review, else null. Pure — unit-tested without a live senior.
 */
export function detectUncapturedReview(full: string): string | null {
  const text = (full || '').trim();
  if (!text) return 'empty transcript (no review text was captured)';
  if (/VERDICT:/i.test(text)) return null; // a real verdict line — trust it
  const hits = SENIOR_HOME_SCREEN_MARKERS.filter(re => re.test(text)).length;
  if (hits >= 2) {
    return `captured the senior app's empty home screen (${hits} chrome markers, no VERDICT line) — the review was never submitted or never generated`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Senior registry
// ---------------------------------------------------------------------------

export interface SeniorConfig {
  id: string;
  label: string;
  kind: 'cli' | 'cdp';
  /** cli: the executable to spawn. cdp: the app binary to launch. */
  binaryCandidates: string[];
  /** Env var overriding the binary path. */
  envPath: string;
  /** cdp only: CDP debug port. */
  cdpPort?: number;
}

function localAppData(): string {
  return process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
}

export const SENIORS: Record<string, SeniorConfig> = {
  claude: {
    id: 'claude',
    label: 'Claude CLI',
    kind: 'cli',
    envPath: 'CLAUDE_CLI_PATH',
    binaryCandidates:
      os.platform() === 'win32'
        ? [
            path.join(os.homedir(), '.local', 'bin', 'claude.cmd'),
            path.join(process.env['APPDATA'] || '', 'npm', 'claude.cmd'),
            'claude.cmd',
            'claude'
          ]
        : [path.join(os.homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', 'claude']
  },
  zai: {
    id: 'zai',
    label: 'ZCode (Z.ai GLM)',
    kind: 'cdp',
    envPath: 'ZCODE_PATH',
    cdpPort: 9335,
    binaryCandidates:
      os.platform() === 'win32'
        ? [path.join(localAppData(), 'Programs', 'ZCode', 'ZCode.exe')]
        : os.platform() === 'darwin'
          ? ['/Applications/ZCode.app/Contents/MacOS/ZCode']
          : ['/usr/bin/zcode', '/opt/ZCode/zcode']
  }
};

/**
 * Assignment policy — pick exactly ONE senior for a given review, because having
 * both review the same artifact is wasteful. Default splits the load: plans go to
 * the Claude senior, walkthroughs to the ZCode (GLM) senior. Override per-kind
 * with env `SENIOR_PLAN` / `SENIOR_WALKTHROUGH`, or globally with `SENIOR_DEFAULT`.
 */
export function assignSenior(opts: { kind: 'plan' | 'walkthrough' }): string {
  const global = process.env['SENIOR_DEFAULT'];
  const perKind = opts.kind === 'plan' ? process.env['SENIOR_PLAN'] : process.env['SENIOR_WALKTHROUGH'];
  const fallback = opts.kind === 'plan' ? 'claude' : 'zai';
  const id = (perKind || global || fallback).toLowerCase();
  return resolveSenior(id).id; // validates
}

/**
 * Assign exactly ONE senior to a whole TASK — its plan review AND its walkthrough
 * review — so the same reviewer holds the task's context end-to-end and no second
 * senior ever reads the same code (the per-kind split sent plan→claude and
 * walkthrough→zai, pulling BOTH seniors onto one task and wasting context/quota).
 * Deterministic by task id, so load still spreads ACROSS tasks (parallelism kept)
 * while each task has a single owner. `SENIOR_DEFAULT` pins all tasks to one
 * senior when set; otherwise a stable hash of the task id picks among the
 * registered seniors. Pairs with the per-round conversation reuse
 * (`freshConversation`): same senior + same conversation across a task's rounds.
 */
export function assignSeniorForTask(taskId: string): string {
  const override = process.env['SENIOR_DEFAULT'];
  if (override) return resolveSenior(override.toLowerCase()).id;
  const ids = Object.keys(SENIORS).sort();
  let h = 0;
  for (let i = 0; i < taskId.length; i++) {
    h = (h * 31 + taskId.charCodeAt(i)) >>> 0;
  }
  return ids[h % ids.length];
}

/**
 * Where to see remaining quota for a senior. ZCode exposes it in-GUI
 * (`ZCodeSession.readUsage`, the "Usage remaining" control). The Claude CLI has
 * no headless quota readout — check it with the `/usage` command inside the
 * Claude Code app, or at console.anthropic.com for API usage.
 */
export function usageHint(id: string): string {
  const cfg = resolveSenior(id);
  return cfg.kind === 'cdp'
    ? 'Driven in-GUI via ZCodeSession.readUsage() ("Usage remaining" control).'
    : "Run `/usage` inside the Claude Code app, or see console.anthropic.com — no headless CLI quota readout.";
}

export function resolveSenior(id?: string): SeniorConfig {
  const key = (id || 'claude').toLowerCase();
  const cfg = SENIORS[key];
  if (!cfg) {
    throw new HarnessError(`Unknown senior '${id}'. Known seniors: ${Object.keys(SENIORS).join(', ')}.`);
  }
  return cfg;
}

export function findSeniorBinary(cfg: SeniorConfig): string {
  const override = process.env[cfg.envPath];
  if (override && fs.existsSync(override)) return override;
  for (const c of cfg.binaryCandidates) {
    // A bare command name (no separator) is resolved on PATH by spawn — accept it.
    if (!c.includes(path.sep) && !c.includes('/')) return c;
    if (fs.existsSync(c)) return c;
  }
  throw new HarnessError(
    `${cfg.label} not found. Set ${cfg.envPath} (looked in: ${cfg.binaryCandidates.join(', ')}).`
  );
}

// ---------------------------------------------------------------------------
// Claude CLI senior (subprocess, headless review)
// ---------------------------------------------------------------------------

/**
 * Claude senior timing is ACTIVITY-based, like the GUI agents' waiter: a review
 * that is streaming output is working and may run arbitrarily long; only a
 * `CLAUDE_SENIOR_STALL_MS` window of TOTAL silence (default 5 min) stops it,
 * with `CLAUDE_SENIOR_MAX_MS` (default 1h) as the last-resort absolute cap so a
 * pathological output loop still terminates. The old single absolute kill timer
 * (`CLAUDE_SENIOR_TIMEOUT_MS`, 20 min) cut claude off mid-review while it was
 * actively producing — its env var still works, as the cap's source.
 */
export const DEFAULT_CLAUDE_SENIOR_STALL_MS = 300000;
export const DEFAULT_CLAUDE_SENIOR_MAX_MS = 3600000;

/** @deprecated kept for back-compat: the old absolute timeout now feeds the cap. */
export const DEFAULT_CLAUDE_SENIOR_TIMEOUT_MS = 1200000;

function positiveMs(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveClaudeSeniorStallMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveMs(env['CLAUDE_SENIOR_STALL_MS'], DEFAULT_CLAUDE_SENIOR_STALL_MS);
}

export function resolveClaudeSeniorMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveMs(env['CLAUDE_SENIOR_MAX_MS'] ?? env['CLAUDE_SENIOR_TIMEOUT_MS'], DEFAULT_CLAUDE_SENIOR_MAX_MS);
}

/** @deprecated use resolveClaudeSeniorMaxMs (the cap) / resolveClaudeSeniorStallMs. */
export function resolveClaudeSeniorTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env['CLAUDE_SENIOR_TIMEOUT_MS'] || DEFAULT_CLAUDE_SENIOR_TIMEOUT_MS);
}

export class ClaudeCliSenior implements SeniorDriver {
  private readonly cfg: SeniorConfig;
  private readonly model?: string;
  constructor(cfg: SeniorConfig = SENIORS.claude, model?: string) {
    this.cfg = cfg;
    this.model = model ?? process.env['CLAUDE_SENIOR_MODEL'];
  }

  async review(input: SeniorReviewInput): Promise<SeniorVerdict> {
    const { system, user } = buildReviewPrompt(input);
    const bin = findSeniorBinary(this.cfg);
    const args = ['-p', '--append-system-prompt', system];
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);
    const raw = await this.spawnClaude(bin, args, user);
    const { verdict, feedback } = parseVerdict(raw);
    return { senior: this.cfg.id, verdict, feedback, raw, model };
  }

  private spawnClaude(bin: string, args: string[], stdin: string): Promise<string> {
    const stallMs = resolveClaudeSeniorStallMs();
    const maxMs = resolveClaudeSeniorMaxMs();
    return new Promise((resolve, reject) => {
      const usesShell = bin.endsWith('.cmd') || bin === 'claude' || bin === 'claude.cmd';
      const child = child_process.spawn(bin, args, {
        // .cmd shims on Windows need a shell to resolve.
        shell: usesShell,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      const killTree = () => {
        // With shell:true on Windows, child.kill() only kills cmd.exe and leaves
        // the real claude process running; taskkill /T takes the whole tree.
        if (usesShell && process.platform === 'win32' && child.pid) {
          child_process.exec(`taskkill /PID ${child.pid} /T /F`);
        } else {
          child.kill();
        }
      };
      // Activity-based give-up: a stall (no output for stallMs) or the absolute
      // cap (maxMs) kills the tree and rejects — the PARTIAL output collected
      // so far is never resolved as if it were a completed review.
      const guard = makeInactivityGuard({
        stallMs,
        maxMs,
        onGiveUp: reason => {
          killTree();
          reject(
            new HarnessError(
              reason === 'stall'
                ? `Claude CLI senior stalled: no output for ${Math.round(stallMs / 1000)}s ` +
                    `(CLAUDE_SENIOR_STALL_MS). Partial output was NOT recorded as a review.`
                : `Claude CLI senior hit the absolute cap of ${Math.round(maxMs / 1000)}s ` +
                    `(CLAUDE_SENIOR_MAX_MS). Partial output was NOT recorded as a review.`
            )
          );
        }
      });
      child.stdout.on('data', d => {
        out += d;
        guard.touch();
      });
      child.stderr.on('data', d => {
        err += d;
        guard.touch();
      });
      child.on('error', e => {
        guard.done();
        reject(new HarnessError(`Claude CLI spawn failed: ${e.message}`));
      });
      child.on('close', code => {
        guard.done();
        if (code !== 0 && !out.trim()) {
          reject(new HarnessError(`Claude CLI senior exited ${code}: ${err.slice(0, 400)}`));
        } else {
          resolve(out.trim());
        }
      });
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

// ---------------------------------------------------------------------------
// ZCode (Z.ai GLM) senior — CDP-driven Electron chat, like the juniors
// ---------------------------------------------------------------------------

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

export async function isSeniorPortLive(port: number): Promise<boolean> {
  try {
    const v = await cdpGet(port, '/json/version');
    return typeof v?.webSocketDebuggerUrl === 'string';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Senior self-healing: relaunch a downed GUI senior instead of dying fail-closed
// ---------------------------------------------------------------------------

/** The senior app's process-image name (what taskkill /IM wants). Pure. */
export function seniorProcessImageName(cfg: SeniorConfig): string {
  const override = process.env[cfg.envPath];
  return processImageName(override || cfg.binaryCandidates.find(c => path.isAbsolute(c)) || cfg.binaryCandidates[0] || cfg.id);
}

/**
 * Best-effort: kill every running process of the senior GUI app. Scar: ZCode
 * keeps a persistent tray process holding the single-instance lock — while it
 * lives, a plain relaunch hands off to it and never re-exposes the debug port,
 * so recovery must kill ALL ZCode processes first. "Not found" is fine; never
 * throws.
 */
export async function killSeniorProcesses(cfg: SeniorConfig): Promise<void> {
  await killProcessesByImageName(seniorProcessImageName(cfg));
}

export interface SeniorEnsureDeps {
  /** Port liveness probe (injectable for unit tests). */
  isPortLive?: (port: number) => Promise<boolean>;
  /** Process kill (injectable for unit tests). */
  killProcesses?: (cfg: SeniorConfig) => Promise<void>;
  /** Launcher (injectable for unit tests). */
  spawn?: (binary: string, args: string[]) => child_process.ChildProcess;
  sleep?: (ms: number) => Promise<void>;
}

export interface SeniorEnsureResult {
  launched: boolean;
  port: number;
  child?: child_process.ChildProcess;
}

/**
 * "See if the senior GUI is open, or open it" — the senior analogue of the
 * junior side's `ensureJuniorRunning`. Reuses a live CDP endpoint on the
 * configured port; else kills any zombie/tray processes of the app (the
 * single-instance-lock scar above), relaunches it with the debug port, and
 * polls until CDP answers. Throws only if the endpoint never comes up.
 */
export async function ensureSeniorRunning(
  cfg: SeniorConfig,
  opts: { timeoutMs?: number; deps?: SeniorEnsureDeps } = {}
): Promise<SeniorEnsureResult> {
  const port = cfg.cdpPort;
  if (!port) throw new HarnessError(`Senior '${cfg.id}' is not a CDP (GUI) senior — nothing to launch.`);
  const deps = {
    isPortLive: opts.deps?.isPortLive ?? isSeniorPortLive,
    killProcesses: opts.deps?.killProcesses ?? killSeniorProcesses,
    spawn:
      opts.deps?.spawn ??
      ((binary: string, args: string[]) => child_process.spawn(binary, args, { detached: true, stdio: 'ignore' })),
    sleep: opts.deps?.sleep ?? (async (ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  };
  if (await deps.isPortLive(port)) return { launched: false, port };
  await deps.killProcesses(cfg);
  const binary = findSeniorBinary(cfg);
  const child = deps.spawn(binary, [`--remote-debugging-port=${port}`]);
  child.unref?.();
  const timeoutMs = opts.timeoutMs ?? 40000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.isPortLive(port)) return { launched: true, port, child };
    await deps.sleep(500);
  }
  throw new HarnessError(
    `${cfg.label} was relaunched but no CDP endpoint appeared on port ${port} within ` +
      `${Math.round(timeoutMs / 1000)}s. Launch it manually with --remote-debugging-port=${port} and retry.`
  );
}

/**
 * Classify a ZCode driver failure as "the app / CDP endpoint died or stopped
 * answering" — worth one relaunch+retry — versus a capture/calibration problem
 * (wrong selector, unverified submit, home-screen capture, stall), which
 * retrying would only reproduce and which must stay fail-closed. Pure.
 */
export function isSeniorConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return (
    /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|abnormal closure|went away/i.test(msg) ||
    /socket|connection failed|websocket is not open|readystate/i.test(msg) ||
    /main window not found on port|cdp timeout/i.test(msg)
  );
}

export interface SeniorRecoveryDeps {
  ensure?: (cfg: SeniorConfig) => Promise<unknown>;
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Run one senior review attempt with self-healing: ensure the app is up first,
 * and if it dies MID-attempt (CDP socket closed / attach failure — NOT a
 * captured home screen or a calibration miss, which `isSeniorConnectionError`
 * excludes), relaunch it ONCE and retry the whole sequence. A second failure —
 * or any non-connection failure — propagates: a partial/aborted review is never
 * recorded as a verdict. Extracted so the retry policy is unit-testable.
 */
export async function runSeniorWithRecovery<T>(
  cfg: SeniorConfig,
  op: () => Promise<T>,
  deps: SeniorRecoveryDeps = {}
): Promise<T> {
  const ensure = deps.ensure ?? ((c: SeniorConfig) => ensureSeniorRunning(c));
  const isRetryable = deps.isRetryable ?? isSeniorConnectionError;
  await ensure(cfg);
  try {
    return await op();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    // The port is dead now, so this ensure force-kills the corpse and relaunches;
    // a merely-flaked connection with the app still up takes the reuse path.
    await ensure(cfg);
    return await op();
  }
}

/** ZCode chat input label(s) to try — calibrated on first live attach. */
export const ZCODE_INPUT_MATCHERS = ['message', 'chat', 'ask', 'prompt', 'input'];

/**
 * Minimal CDP chat session for ZCode. Structured like AntigravitySession but
 * with a best-effort input finder (ZCode's exact selector is calibrated on the
 * first live attach — see docs/senior-integration.md). Sends a prompt and reads
 * the reply tail.
 */
export class ZCodeSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readonly wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  static async attach(port: number): Promise<ZCodeSession> {
    const targets = await cdpGet(port, '/json/list');
    const pages = (targets as any[]).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    const page =
      pages.find(t => typeof t.url === 'string' && t.url.startsWith('https://127.0.0.1')) ??
      pages.find(t => typeof t.url === 'string' && t.url.startsWith('vscode-file://')) ??
      pages.find(t => typeof t.url === 'string' && !t.url.startsWith('data:'));
    if (!page) throw new HarnessError(`ZCode main window not found on port ${port}`);
    const s = new ZCodeSession(page.webSocketDebuggerUrl);
    await s.connect();
    return s;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new HarnessError('ZCode CDP WebSocket connection failed'));
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

  private async pressKey(key: string, code: string, vk: number, ctrl = false): Promise<void> {
    const modifiers = ctrl ? 2 : 0;
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', {
        type, key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
      });
    }
  }

  /** Start a fresh ZCode conversation so a prior review can't bleed into this one. */
  async newConversation(): Promise<boolean> {
    await this.pressKey('Escape', 'Escape', 27);
    return !!(await this.evaluate(`(() => {
      // ZCode 3.9.2: the new-conversation control is [data-testid="conversation-new-task"];
      // fall back to the label match for older builds.
      const b = document.querySelector('[data-testid="conversation-new-task"]')
        || [...document.querySelectorAll('button,[role=button],a')]
             .find(x => /^(new task|new conversation|new chat)$/i.test(((x.getAttribute('aria-label')||x.innerText)||'').trim()));
      if (!b) return false; b.click(); return true;
    })()`));
  }

  /**
   * Type the review into ZCode's chat input and submit — VERIFIED at both ends,
   * because a silent no-op here was the root of the phantom-REVISE loop: if the
   * prompt never landed in a real input, or was typed but never submitted, ZCode
   * stayed on its home screen and the harness "completed" against the welcome
   * chrome, which `parseVerdict` fail-closed into a spurious REVISE.
   *
   * We tag the exact element we focus (`data-bureau-input`) so the insertion and
   * submission checks read back the SAME box — not some other editable on the
   * page. Insertion that didn't land, or a prompt still sitting unsent after the
   * Enter + Send-button fallback, is a HARD failure (recalibrate), never a
   * best-effort "probably fine".
   */
  async sendPrompt(prompt: string): Promise<void> {
    await this.pressKey('Escape', 'Escape', 27);
    const matchers = JSON.stringify(ZCODE_INPUT_MATCHERS);
    const focused = await this.evaluate(`(() => {
      const cands = [...document.querySelectorAll('[contenteditable="true"],textarea')];
      const want = ${matchers};
      const score = e => {
        const a = ((e.getAttribute('aria-label')||'') + ' ' + (e.getAttribute('placeholder')||'')).toLowerCase();
        return want.some(w => a.includes(w)) ? 1 : 0;
      };
      // ZCode 3.9.2: the composer is [data-testid="v4-composer-input"] — a
      // role=textbox contenteditable with NO aria-label/placeholder, so the scored
      // heuristic never matched and the "last contenteditable" fallback grabbed the
      // wrong editable when the projects panel was mounted (the prompt never landed,
      // the harness captured the home-screen chrome, and the phantom-verdict guard
      // fail-closed the review). Target the composer testid explicitly first; keep the
      // scored/last-editable fallback for older builds. Tag it so the insert/submit
      // checks below re-find THIS element.
      const el = document.querySelector('[data-testid="v4-composer-input"]') || cands.find(score) || cands[cands.length - 1];
      if (!el) return false;
      el.focus();
      el.setAttribute('data-bureau-input', '1');
      return true;
    })()`);
    if (!focused) throw new HarnessError('ZCode chat input not found (needs selector calibration)');
    await this.pressKey('a', 'KeyA', 65, true);
    await this.pressKey('Delete', 'Delete', 46);
    await this.send('Input.insertText', { text: prompt });
    await new Promise(r => setTimeout(r, 300));
    // Verify the text actually landed in the box we focused. If it didn't, we
    // targeted the wrong element (or focus was stolen) — fail loudly rather than
    // press Enter on an empty home-screen box.
    const inserted = await this.evaluate(`(() => {
      const el = document.querySelector('[data-bureau-input="1"]');
      return !!el && (el.innerText || el.value || '').trim().length > 0;
    })()`);
    if (!inserted) {
      await this.evaluate(`(() => { const el = document.querySelector('[data-bureau-input="1"]'); if (el) el.removeAttribute('data-bureau-input'); })()`);
      throw new HarnessError(
        'ZCode: the review prompt did not land in the chat input (wrong selector or focus lost). ' +
          'Recalibrate ZCODE_INPUT_MATCHERS in engine/harness/senior.ts.'
      );
    }
    // Submit by clicking the composer's Send control — NOT by pressing Enter.
    // Calibrated live against ZCode 3.8.1 (2026-08-26): the composer is multiline,
    // so Enter inserts a newline and never submits; and its rich-text editor does
    // NOT clear the contenteditable's DOM text when a message is sent. The old
    // "press Enter, then check the box emptied" therefore mis-fired both ways.
    // The real control is `button[data-testid="v4-composer-send"]` (aria-label
    // "Send", type=submit), enabled ONLY while the editor MODEL is non-empty and
    // flipping back to DISABLED the instant a send is accepted. So we click it and
    // read the enabled→disabled flip (or a Stop/generating control) as the submit
    // signal — never the DOM text, which lingers after a real send.
    const clicked = await this.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="v4-composer-send"]')
        || [...document.querySelectorAll('button,[role=button]')].find(b =>
             ((b.getAttribute('aria-label')||'').trim().toLowerCase() === 'send')
             || (b.getAttribute('type') === 'submit' && /\\bsend\\b/i.test(b.innerText||'')));
      if (!btn) return 'no-button';
      if (btn.disabled === true || btn.getAttribute('aria-disabled') === 'true') return 'disabled';
      btn.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') {
      await this.evaluate(`(() => { const el = document.querySelector('[data-bureau-input="1"]'); if (el) el.removeAttribute('data-bureau-input'); })()`);
      throw new HarnessError(
        clicked === 'disabled'
          ? 'ZCode: the Send control was disabled after typing — the review prompt did not register in the ' +
              'composer model. Recalibrate text insertion in engine/harness/senior.ts.'
          : 'ZCode: no composer Send control found ([data-testid="v4-composer-send"] / aria-label "Send"). ' +
              'Recalibrate the Send selector in engine/harness/senior.ts.'
      );
    }
    // Confirm the send was ACCEPTED: the Send button re-disables (model emptied)
    // or a Stop/generating control appears. Poll briefly; the DOM text is NOT a
    // reliable signal for this editor, so we never read it here.
    let submitted = false;
    for (let i = 0; i < 20 && !submitted; i++) {
      await new Promise(r => setTimeout(r, 150));
      submitted = await this.evaluate(`(() => {
        const btn = document.querySelector('[data-testid="v4-composer-send"]')
          || [...document.querySelectorAll('button,[role=button]')].find(b => (b.getAttribute('aria-label')||'').trim().toLowerCase() === 'send');
        const sendGone = !btn || btn.disabled === true || btn.getAttribute('aria-disabled') === 'true';
        const generating = [...document.querySelectorAll('button,[role=button]')]
          .some(b => /^(stop|cancel)$/i.test(((b.getAttribute('aria-label')||b.innerText)||'').trim()));
        return sendGone || generating;
      })()`);
    }
    await this.evaluate(`(() => { const el = document.querySelector('[data-bureau-input="1"]'); if (el) el.removeAttribute('data-bureau-input'); })()`);
    if (!submitted) {
      throw new HarnessError(
        'ZCode: clicked Send but saw no submit (button never re-disabled, no generating indicator). ' +
          'Recalibrate the submit signal in engine/harness/senior.ts.'
      );
    }
  }

  /**
   * Drive ZCode's model picker: open `button[aria-label="Choose model"]`, then
   * click the option whose visible text starts with `modelName` (e.g. "GLM-5.2",
   * "GLM-4.6"). Returns the model label now shown on the picker button.
   */
  async selectModel(modelName: string): Promise<string> {
    await this.pressKey('Escape', 'Escape', 27);
    const opened = await this.evaluate(`(() => {
      // ZCode 3.9.2: the model picker trigger is [data-testid="chat-model-select-trigger"]
      // (was aria-label="Choose model"). Try the testid first, then the old label.
      const b = document.querySelector('[data-testid="chat-model-select-trigger"]')
        || [...document.querySelectorAll('button,[role=button]')]
             .find(x => (x.getAttribute('aria-label')||'') === 'Choose model');
      if (!b) return false; b.click(); return true;
    })()`);
    if (!opened) throw new HarnessError('ZCode model picker ("Choose model") not found');
    await new Promise(r => setTimeout(r, 600));
    const picked = await this.evaluate(`(() => {
      const want = ${JSON.stringify(modelName)}.toLowerCase();
      const nodes = [...document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],button,[role=button],li,div,span')];
      const leaf = nodes.filter(e => e.children.length <= 2);
      const hit = leaf.find(e => (e.innerText||'').trim().toLowerCase().startsWith(want))
        || leaf.find(e => (e.innerText||'').trim().toLowerCase().includes(want));
      if (!hit) return false; hit.click(); return true;
    })()`);
    if (!picked) {
      await this.pressKey('Escape', 'Escape', 27);
      throw new HarnessError(`Model '${modelName}' not offered in ZCode's picker`);
    }
    await new Promise(r => setTimeout(r, 400));
    const label = await this.evaluate(`(() => {
      const b = document.querySelector('[data-testid="chat-model-select-trigger"]')
        || [...document.querySelectorAll('button,[role=button]')]
             .find(x => (x.getAttribute('aria-label')||'') === 'Choose model');
      return b ? (b.innerText||'').trim() : '';
    })()`);
    return label || modelName;
  }

  /**
   * Read the remaining-quota indicator. ZCode surfaces it on the
   * `aria-label="Usage remaining"` control; this opens it and returns the nearby
   * text (best-effort — the readout is a popover/tooltip). Returns '' if not found.
   */
  async readUsage(): Promise<string> {
    const found = await this.evaluate(`(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
        .find(x => (x.getAttribute('aria-label')||'') === 'Usage remaining');
      if (!b) return false; b.click(); return true;
    })()`);
    if (!found) return '';
    await new Promise(r => setTimeout(r, 600));
    const text = await this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[role=dialog],[role=tooltip],[data-radix-popper-content-wrapper],[class*="popover"],[class*="usage"]')];
      const txt = nodes.map(n => (n.innerText||'').trim()).filter(Boolean).join('\\n');
      return txt.slice(0, 500);
    })()`);
    await this.pressKey('Escape', 'Escape', 27);
    return text || '';
  }

  private async probeActivity(): Promise<AgentActivity> {
    return (await this.evaluate(`(() => {
      // Calibrated live against ZCode 3.8.1 (2026-08-26). While GLM generates, the
      // composer's Send button is REPLACED by a Stop button
      // (data-testid="v4-stop"); when it finishes, the Send button
      // (data-testid="v4-composer-send") returns. These testids are the reliable
      // activity signals — they do NOT collide with the composer's own
      // "Add context"/"Full access"/"Plan mode" controls, whose text the OLD
      // home-screen heuristic mistook for the welcome screen, so canSend was
      // pinned false and every finished review was misread as a stall.
      const stopBtn = !!document.querySelector('[data-testid="v4-stop"]');
      const sendBtn = document.querySelector('[data-testid="v4-composer-send"]');
      // Fallbacks (label-based) in case the testids drift again.
      const labelStop = [...document.querySelectorAll('button,[role=button]')]
        .some(b => /^(stop|cancel)$/i.test(((b.getAttribute('aria-label')||b.innerText)||'').trim()));
      // A live progress indicator is a SMALL standalone status label ("Working",
      // "Generating…") — NOT the word buried in the reply prose (e.g. "working tree
      // clean"). Match only a leaf element whose ENTIRE text is a progress word.
      const progressRe = new RegExp(${JSON.stringify(AGENT_PROGRESS_LABEL_RE.source)}, 'i');
      const statusWorking = [...document.querySelectorAll('span,div,p,button,[role=status],[aria-live]')]
        .some(e => e.children.length === 0 && progressRe.test((e.innerText||'').trim()));
      const working = stopBtn || labelStop || statusWorking;
      // Ready for the next message (idle/done) = the Send button is back AND we are
      // not mid-generation. The empty home screen also shows a Send button, but by
      // the time we wait we have already submitted a prompt (sendPrompt verifies
      // the send landed), so a present-and-not-working Send button here means the
      // reply is finished — not the welcome screen.
      const canSend = !!sendBtn && !working;
      return { working, canSend, len: document.body.innerText.length };
    })()`)) as AgentActivity;
  }

  /**
   * Wait until ZCode finishes — adaptively, with NO hard time cap. A GLM senior
   * that re-runs the suite and browses the app is working, not stuck; we keep
   * waiting while it's active and only stop on genuine completion or a stall.
   */
  async waitForCompletion(opts: WaitOptions = {}): Promise<WaitResult> {
    // requireActivityStart: after sendPrompt there is a brief gap before GLM shows
    // its Stop button / "Thinking…" indicator, during which the composer looks idle
    // (Send control back, nothing streaming). Without this, the waiter counted that
    // gap as an instant "completion" (~5-9s) and captured the app chrome before the
    // VERDICT line existed — the review was abandoned while GLM kept working, so the
    // verdict was orphaned and the job died on detectUncapturedReview. Requiring an
    // observed start closes that race; a submit that never starts now stalls loudly.
    return waitForAgentIdle(() => this.probeActivity(), { requireActivityStart: true, ...opts });
  }

  async readTranscript(lastLines = 60): Promise<string> {
    return (
      (await this.evaluate(
        `document.body.innerText.split('\\n').map(l=>l.trim()).filter(Boolean).slice(-${lastLines}).join('\\n')`
      )) || ''
    );
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

export class ZCodeSenior implements SeniorDriver {
  private readonly cfg: SeniorConfig;
  /** Inactivity (stall) window: how long with NO progress before giving up. Not a
   *  cap on total review time — an actively working senior extends indefinitely. */
  private readonly waitMs: number;
  constructor(cfg: SeniorConfig = SENIORS.zai, waitMs = 120000) {
    this.cfg = cfg;
    this.waitMs = waitMs;
  }

  async review(input: SeniorReviewInput): Promise<SeniorVerdict> {
    // Self-heal instead of dying: ensure ZCode is up (relaunching it if it went
    // down), and if it dies MID-review, relaunch once and retry.
    return await runSeniorWithRecovery(this.cfg, () => this.reviewOnce(input));
  }

  private async reviewOnce(input: SeniorReviewInput): Promise<SeniorVerdict> {
    const port = this.cfg.cdpPort!;
    const { system, user } = buildReviewPrompt(input);
    const prompt = `${system}\n\n${user}`;
    const session = await ZCodeSession.attach(port);
    try {
      // First round starts a fresh conversation; a continuation round (round 2+
      // of the SAME task's review cycle) REUSES the existing conversation so the
      // GLM senior keeps the prior artifact + its own feedback in context — no
      // cold new window per round. The model was already picked on round 1, so we
      // don't re-open the picker mid-thread.
      const startFresh = input.freshConversation !== false;
      let model: string | undefined = input.model;
      if (startFresh) {
        const fresh = await session.newConversation();
        if (!fresh) {
          throw new HarnessError(
            'ZCode: could not start a fresh conversation (no New task/conversation/chat control). ' +
              'Refusing to review against unknown prior context — recalibrate the selector.'
          );
        }
        await new Promise(r => setTimeout(r, 800));
        if (input.model) model = await session.selectModel(input.model);
      }
      await session.sendPrompt(prompt);
      // No hard cap: GLM often verifies claims by re-running the suite/build/browser
      // itself (good!). Keep waiting while it's active; only the inactivity window
      // bounds it. A stall/abort is a hard failure — a partial review must never be
      // recorded as a verdict.
      const waited = await session.waitForCompletion({ stallMs: this.waitMs });
      ensureCompleted(waited, 'ZCode (zai) senior');
      // Wide window: the VERDICT line is the FIRST line of the reply, so a small
      // tail read would drop it on any review longer than the window.
      const full = await session.readTranscript(400);
      // Isolate THIS round's reply FIRST, then guard/parse on it. Critical for
      // continuation rounds (freshConversation:false, rounds 2+ — exactly where the
      // phantom-REVISE incident happened): the 400-line tail can still contain an
      // EARLIER round's genuine `VERDICT:` line, so guarding on the full transcript
      // would see that stale marker, bypass the check, and let the CURRENT round's
      // home-screen chrome fail-close to a spurious REVISE — the very bug this
      // guards against. `raw` falls back to `full` when the prompt boundary isn't
      // found, so the single-round case is unchanged.
      const raw = sliceAfterPrompt(full, prompt) || full;
      // Guard against the phantom-REVISE loop: if we captured the app's empty
      // home screen instead of a review, FAIL — never let `parseVerdict` turn that
      // chrome into a spurious REVISE that re-dispatches the whole task.
      const uncaptured = detectUncapturedReview(raw);
      if (uncaptured) {
        throw new HarnessError(
          `ZCode (zai) senior review was not captured: ${uncaptured}. Refusing to record a phantom verdict.`
        );
      }
      const { verdict, feedback } = parseVerdict(raw);
      return { senior: this.cfg.id, verdict, feedback, raw, model };
    } finally {
      session.close();
    }
  }
}

/** Construct the driver for a senior id. */
export function makeSeniorDriver(id?: string): SeniorDriver {
  const cfg = resolveSenior(id);
  return cfg.kind === 'cli' ? new ClaudeCliSenior(cfg) : new ZCodeSenior(cfg);
}
