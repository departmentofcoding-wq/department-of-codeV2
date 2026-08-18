import child_process from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from './errors.ts';

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

/** Find the main IDE window's WebSocket debugger URL (not the loading splash). */
export async function findMainWindowWs(port: number = ANTIGRAVITY_DEFAULT_PORT): Promise<string> {
  const targets = await cdpGet(port, '/json/list');
  const pages = (targets as any[]).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  // Prefer the https workbench window; never the data: splash.
  const page =
    pages.find(t => typeof t.url === 'string' && t.url.startsWith(ANTIGRAVITY_WORKBENCH_URL_PREFIX)) ??
    pages.find(t => typeof t.url === 'string' && !t.url.startsWith('data:'));
  if (!page) {
    throw new HarnessError(
      `Main Antigravity window not found on port ${port} (still loading?). Retry shortly.`
    );
  }
  return page.webSocketDebuggerUrl;
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

  private async pressKey(key: string, code: string, vk: number): Promise<void> {
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk
      });
    }
  }

  /** Focus the agent chat input, type the command, and submit it. */
  async sendPrompt(prompt: string): Promise<void> {
    // Dismiss any stray open menu (e.g. the model picker) so it can't swallow
    // focus or keystrokes, then land focus on the chat input.
    await this.pressKey('Escape', 'Escape', 27);
    const focused = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"],textarea')]
        .find(e => (e.getAttribute('aria-label')||e.getAttribute('placeholder')) === ${JSON.stringify(ANTIGRAVITY_INPUT_LABEL)});
      if (!el) return false; el.focus(); return true;
    })()`);
    if (!focused) throw new HarnessError(`Chat input ('${ANTIGRAVITY_INPUT_LABEL}') not found`);
    await this.send('Input.insertText', { text: prompt });
    await new Promise(r => setTimeout(r, 300));
    await this.pressKey('Enter', 'Enter', 13);
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
