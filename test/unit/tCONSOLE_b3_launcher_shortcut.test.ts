import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  mintToken,
  buildLaunchUrl,
  parseArgs,
  main as consoleLauncherMain
} from '../../scripts/console.ts';
import { CONSOLE_BIND_HOST, CONSOLE_DEFAULT_PORT } from '../../console/contract.ts';

describe('Milestone B3 — Action UX & Desktop Shortcut Launcher (T-C6)', () => {
  it('1. Token Minting & URL Format: mints 32-byte hex token and formats localhost URL', () => {
    const token = mintToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const url = buildLaunchUrl(token, CONSOLE_DEFAULT_PORT);
    expect(url).toBe(`http://${CONSOLE_BIND_HOST}:${CONSOLE_DEFAULT_PORT}/?token=${token}`);
  });

  it('2. Argument Parsing & --no-open Flag: parses CLI flags correctly', () => {
    const parsedDefault = parseArgs([]);
    expect(parsedDefault.noOpen).toBe(false);
    expect(parsedDefault.port).toBe(CONSOLE_DEFAULT_PORT);

    const parsedNoOpen = parseArgs(['--no-open', '--port', '3999']);
    expect(parsedNoOpen.noOpen).toBe(true);
    expect(parsedNoOpen.port).toBe(3999);
  });

  it('3. Launcher CLI Execution (--no-open): mints token and URL without opening browser', async () => {
    const result = await consoleLauncherMain(['--no-open']);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.url).toContain(`http://${CONSOLE_BIND_HOST}:${CONSOLE_DEFAULT_PORT}/?token=${result.token}`);
  });

  it.skipIf(process.platform !== 'win32')(
    '4. PowerShell Desktop Shortcut Generator Dry-Run (-WhatIf) (B-3): targets launcher with correct CWD without mutating disk',
    () => {
      const scriptPath = join(__dirname, '../../scripts/install_console_shortcut.ps1');
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -WhatIf`;

      const output = execSync(cmd, { encoding: 'utf8' });
      expect(output).toContain('[WhatIf] Target Shortcut:');
      expect(output).toContain('scripts\\console.ts');
      expect(output).toContain('Department Console.lnk');
    }
  );
});
