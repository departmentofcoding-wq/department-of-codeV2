import child_process from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mintNonce } from '../contract/harness-pure.ts';
import type {
  IdeDriver,
  IdeDriverActResult,
  IdeDriverAction,
  IdeDriverLaunchOptions,
  IdeDriverReadResult,
  IdeDriverSnapshotResult
} from '../contract/types.ts';
import { HarnessError } from './errors.ts';

export function findBrowserBinary(): string {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH)) {
    return process.env.EDGE_PATH;
  }

  const platform = os.platform();
  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';

    candidates.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/msedge'
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new HarnessError('No Chrome or Edge browser binary found. Please install Chrome or Edge to run harness tests.');
}

export class CdpIdeDriver implements IdeDriver {
  private resolveSelector: (key: string) => string;
  private proc: child_process.ChildProcess | null = null;
  private userDataDir: string | null = null;
  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();

  constructor(resolveSelector: (key: string) => string) {
    this.resolveSelector = resolveSelector;
  }

  public async launch(opts?: IdeDriverLaunchOptions): Promise<void> {
    const binaryPath = findBrowserBinary();
    this.userDataDir = opts?.userDir || fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-cdp-profile-'));

    const headlessFlag = opts?.headless === false ? '--headless=false' : '--headless=new';
    const args = [
      headlessFlag,
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ];

    this.proc = child_process.spawn(binaryPath, args, {
      stdio: 'ignore',
      detached: false
    });

    // Wait for DevToolsActivePort file
    const activePortPath = path.join(this.userDataDir, 'DevToolsActivePort');
    let portStr = '';
    const startMs = Date.now();

    while (Date.now() - startMs < 10000) {
      if (fs.existsSync(activePortPath)) {
        const content = fs.readFileSync(activePortPath, 'utf8').trim();
        const lines = content.split('\n');
        if (lines.length > 0 && lines[0].trim().length > 0) {
          portStr = lines[0].trim();
          break;
        }
      }
      await new Promise(res => setTimeout(res, 50));
    }

    if (!portStr) {
      this.close();
      throw new HarnessError('Failed to read DevToolsActivePort from browser profile directory');
    }

    const port = Number.parseInt(portStr, 10);

    // Poll /json/list for a page target WebSocket URL
    let wsUrl = '';
    const versionStartMs = Date.now();

    while (Date.now() - versionStartMs < 10000) {
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body));
          });
          req.on('error', reject);
          req.setTimeout(500, () => {
            req.destroy();
            reject(new Error('Timeout'));
          });
        });

        const targets = JSON.parse(data);
        if (Array.isArray(targets)) {
          const pageTarget = targets.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (pageTarget) {
            wsUrl = pageTarget.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {
        await new Promise(res => setTimeout(res, 100));
      }
    }

    if (!wsUrl) {
      this.close();
      throw new HarnessError('Failed to retrieve page webSocketDebuggerUrl from DevTools HTTP endpoint');
    }

    // Connect WebSocket using Node global WebSocket
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new HarnessError('WebSocket not initialized'));

      const timer = setTimeout(() => {
        reject(new HarnessError('WebSocket connection timeout'));
      }, 5000);

      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      this.ws.onerror = err => {
        clearTimeout(timer);
        reject(new HarnessError(`WebSocket connection error: ${String(err)}`));
      };

      this.ws.onmessage = event => {
        this.handleWsMessage(String(event.data));
      };
    });

    // Enable basic CDP domains
    await this.sendCdpCommand('Page.enable');
    await this.sendCdpCommand('DOM.enable');
    await this.sendCdpCommand('Runtime.enable');
  }

  private async ensureConnected(): Promise<void> {
    if (!this.ws) {
      await this.launch();
    }
  }

  public async navigate(url: string): Promise<void> {
    await this.ensureConnected();
    const result = await this.sendCdpCommand('Page.navigate', { url });
    if (result.errorText) {
      throw new HarnessError(`Page.navigate failed: ${result.errorText}`, url, 'Page.navigate');
    }
  }

  public async read(selectorKey: string): Promise<IdeDriverReadResult> {
    await this.ensureConnected();

    const css = this.resolveSelector(selectorKey);
    const nonce = mintNonce();

    const script = `
      ((css) => {
        const els = document.querySelectorAll(css);
        if (els.length === 0) {
          return { matchCount: 0 };
        }
        const el = els[0];
        const attrs = {};
        for (let i = 0; i < el.attributes.length; i++) {
          const a = el.attributes[i];
          attrs[a.name] = a.value;
        }
        return {
          matchCount: els.length,
          text: el.innerText || el.textContent || '',
          attrs: attrs
        };
      })(${JSON.stringify(css)})
    `;

    const response = await this.sendCdpCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    if (response.exceptionDetails) {
      throw new HarnessError(`Runtime.evaluate failed during read: ${JSON.stringify(response.exceptionDetails)}`, selectorKey, 'read');
    }

    const val = response.result?.value || { matchCount: 0 };
    return {
      matchCount: val.matchCount ?? 0,
      text: val.text,
      attrs: val.attrs,
      nonceEcho: nonce
    };
  }

  public async act(selectorKey: string, action: IdeDriverAction, value?: string): Promise<IdeDriverActResult> {
    await this.ensureConnected();

    const css = this.resolveSelector(selectorKey);
    const nonce = mintNonce();

    const script = `
      ((css, actKind, actVal) => {
        const els = document.querySelectorAll(css);
        if (els.length === 0) {
          return { success: false, reason: 'No element matching selector' };
        }
        const el = els[0];
        if (actKind === 'click') {
          el.click();
        } else if (actKind === 'type') {
          el.value = (el.value || '') + (actVal || '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (actKind === 'clear') {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (actKind === 'press') {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: actVal || 'Enter', bubbles: true }));
        } else if (actKind === 'select') {
          el.value = actVal || '';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.click();
        }
        return { success: true };
      })(${JSON.stringify(css)}, ${JSON.stringify(action)}, ${JSON.stringify(value ?? null)})
    `;

    const response = await this.sendCdpCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    if (response.exceptionDetails) {
      throw new HarnessError(`Runtime.evaluate failed during act: ${JSON.stringify(response.exceptionDetails)}`, selectorKey, String(action));
    }

    const val = response.result?.value || { success: false };
    return {
      success: Boolean(val.success),
      nonceEcho: nonce
    };
  }

  public async snapshot(): Promise<IdeDriverSnapshotResult> {
    await this.ensureConnected();

    const script = `
      (() => {
        if (!document.body) return '';
        return document.body.outerHTML || document.body.innerText || '';
      })()
    `;

    const response = await this.sendCdpCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    const outline = String(response.result?.value || '');
    return { outline };
  }

  public async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignored
      }
      this.ws = null;
    }

    if (this.proc && !this.proc.killed) {
      const procRef = this.proc;
      const exitPromise = new Promise<void>(resolve => {
        procRef.once('exit', () => resolve());
      });

      try {
        procRef.kill('SIGTERM');
      } catch {
        // Ignored
      }

      const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 2000));
      await Promise.race([exitPromise, timeoutPromise]);

      if (!procRef.killed) {
        try {
          procRef.kill('SIGKILL');
        } catch {
          // Ignored
        }
      }
      this.proc = null;
    }

    if (this.userDataDir && fs.existsSync(this.userDataDir)) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
      } catch (err) {
        // On Windows file locks, re-attempt after short pause
        await new Promise(r => setTimeout(r, 100));
        try {
          fs.rmSync(this.userDataDir, { recursive: true, force: true });
        } catch {
          // Ignored
        }
      }
      this.userDataDir = null;
    }
  }

  private sendCdpCommand(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new HarnessError('WebSocket is not connected', undefined, method));
      }

      const id = this.nextRequestId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new HarnessError(`CDP command timed out: ${method}`, undefined, method));
      }, 10000);

      this.pendingRequests.set(id, {
        resolve: val => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: err => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleWsMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const { resolve, reject } = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          reject(new HarnessError(`CDP error ${msg.error.code}: ${msg.error.message}`, undefined, msg.method));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // Ignore unparseable frames
    }
  }
}
