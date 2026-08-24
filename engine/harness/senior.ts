import child_process from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.ts';
import { sliceAfterPrompt } from './antigravity.ts';
import { AGENT_PROGRESS_LABEL_RE, ensureCompleted, waitForAgentIdle, type AgentActivity, type WaitOptions, type WaitResult } from './agent-wait.ts';

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
      const timer = setTimeout(() => {
        killTree();
        reject(new HarnessError('Claude CLI senior timed out'));
      }, Number(process.env['CLAUDE_SENIOR_TIMEOUT_MS'] || 180000));
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (err += d));
      child.on('error', e => {
        clearTimeout(timer);
        reject(new HarnessError(`Claude CLI spawn failed: ${e.message}`));
      });
      child.on('close', code => {
        clearTimeout(timer);
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
      const b = [...document.querySelectorAll('button,[role=button],a')]
        .find(x => /^(new task|new conversation|new chat)$/i.test(((x.getAttribute('aria-label')||x.innerText)||'').trim()));
      if (!b) return false; b.click(); return true;
    })()`));
  }

  /** Type the review into ZCode's chat input and submit (Enter, then Send button fallback). */
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
      const el = cands.find(score) || cands[cands.length - 1];
      if (!el) return false; el.focus(); return true;
    })()`);
    if (!focused) throw new HarnessError('ZCode chat input not found (needs selector calibration)');
    await this.pressKey('a', 'KeyA', 65, true);
    await this.pressKey('Delete', 'Delete', 46);
    await this.send('Input.insertText', { text: prompt });
    await new Promise(r => setTimeout(r, 300));
    await this.pressKey('Enter', 'Enter', 13);
    await new Promise(r => setTimeout(r, 400));
    await this.evaluate(`(() => {
      const send = [...document.querySelectorAll('button,[role=button]')]
        .find(b => /send|submit/i.test((b.getAttribute('aria-label')||b.innerText||'')));
      const inputs = [...document.querySelectorAll('[contenteditable="true"],textarea')];
      const still = inputs.some(e => (e.innerText||e.value||'').trim().length > 0);
      if (still && send) { send.click(); return 'sent-button'; }
      return 'sent-enter';
    })()`);
  }

  /**
   * Drive ZCode's model picker: open `button[aria-label="Choose model"]`, then
   * click the option whose visible text starts with `modelName` (e.g. "GLM-5.2",
   * "GLM-4.6"). Returns the model label now shown on the picker button.
   */
  async selectModel(modelName: string): Promise<string> {
    await this.pressKey('Escape', 'Escape', 27);
    const opened = await this.evaluate(`(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
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
      const b = [...document.querySelectorAll('button,[role=button]')]
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
      const btns = [...document.querySelectorAll('button,[role=button]')];
      const has = re => btns.some(b => re.test(((b.getAttribute('aria-label')||b.innerText)||'').trim()));
      // A live progress indicator is a SMALL standalone status label ("Working",
      // "Generating…", "Thinking…") — NOT the word buried in the agent's own reply
      // prose (e.g. "working tree clean"), which used to make the waiter believe the
      // agent was still generating forever and run to the job timeout with no
      // verdict captured. Match a leaf element whose ENTIRE text is a progress word
      // (optional trailing dots/ellipsis); Stop/Cancel stays the primary signal.
      const progressRe = new RegExp(${JSON.stringify(AGENT_PROGRESS_LABEL_RE.source)}, 'i');
      const statusWorking = [...document.querySelectorAll('span,div,p,button,[role=status],[aria-live]')]
        .some(e => e.children.length === 0 && progressRe.test((e.innerText||'').trim()));
      const working = has(/^(stop|cancel)$/i) || statusWorking;
      const canSend = has(/^send$/i);
      return { working, canSend, len: document.body.innerText.length };
    })()`)) as AgentActivity;
  }

  /**
   * Wait until ZCode finishes — adaptively, with NO hard time cap. A GLM senior
   * that re-runs the suite and browses the app is working, not stuck; we keep
   * waiting while it's active and only stop on genuine completion or a stall.
   */
  async waitForCompletion(opts: WaitOptions = {}): Promise<WaitResult> {
    return waitForAgentIdle(() => this.probeActivity(), opts);
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
    const port = this.cfg.cdpPort!;
    if (!(await isSeniorPortLive(port))) {
      throw new HarnessError(
        `ZCode is not exposing a CDP endpoint on port ${port}. Fully quit ZCode, then relaunch it ` +
          `with --remote-debugging-port=${port} (Electron requires the flag at launch; login is kept ` +
          `only on the default profile). See docs/senior-integration.md.`
      );
    }
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
      // Isolate the verdict from THIS review, not stale conversation history.
      const raw = sliceAfterPrompt(full, prompt) || full;
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
