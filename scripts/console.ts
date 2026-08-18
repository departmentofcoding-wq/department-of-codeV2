import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import {
  CONSOLE_BIND_HOST,
  CONSOLE_DEFAULT_PORT,
  CONSOLE_QUERY_TOKEN_PARAM
} from '../console/contract.ts';

/**
 * Pure helper: Mints a 32-byte cryptographic hex token (Senior B-6).
 * @returns {string}
 */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Pure helper: Builds the tokenized launch URL (Senior B-6).
 * @param {string} token
 * @param {number} [port=CONSOLE_DEFAULT_PORT]
 * @returns {string}
 */
export function buildLaunchUrl(token: string, port: number = CONSOLE_DEFAULT_PORT): string {
  if (!token) {
    throw new Error('Token is required to build launch URL');
  }
  return `http://${CONSOLE_BIND_HOST}:${port}/?${CONSOLE_QUERY_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Pure helper: Parses CLI command line arguments.
 * @param {string[]} args
 * @returns {{ noOpen: boolean; port: number }}
 */
export function parseArgs(args: string[]): { noOpen: boolean; port: number } {
  const noOpen = args.includes('--no-open') || process.env.CONSOLE_NO_OPEN === '1';
  const portArgIndex = args.indexOf('--port');
  let port = CONSOLE_DEFAULT_PORT;
  if (portArgIndex !== -1 && args[portArgIndex + 1]) {
    const parsed = parseInt(args[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      port = parsed;
    }
  }
  return { noOpen, port };
}

/**
 * Opens a URL in the user's default browser based on OS platform.
 * @param {string} url
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let command = '';
    if (process.platform === 'win32') {
      command = `start "" "${url}"`;
    } else if (process.platform === 'darwin') {
      command = `open "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }

    exec(command, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Main launcher entry point.
 * @param {string[]} [cliArgs=process.argv.slice(2)]
 */
export async function main(cliArgs: string[] = process.argv.slice(2)): Promise<{ token: string; url: string }> {
  const { noOpen, port } = parseArgs(cliArgs);
  const token = mintToken();
  const launchUrl = buildLaunchUrl(token, port);

  console.log('====================================================');
  console.log('  Department of Code — Operator Console Launcher  ');
  console.log('====================================================');
  console.log(`Bind Host : ${CONSOLE_BIND_HOST}`);
  console.log(`Port      : ${port}`);
  console.log(`Launch URL: ${launchUrl}`);
  console.log('====================================================');

  if (noOpen) {
    console.log('[CONSOLE] --no-open flag detected. Suppressing browser launch.');
  } else {
    console.log('[CONSOLE] Opening browser to tokenized URL...');
    try {
      await openBrowser(launchUrl);
    } catch (e) {
      console.warn('[CONSOLE] Failed to auto-open browser:', (e as Error).message);
    }
  }

  return { token, url: launchUrl };
}

// Auto-run if executed directly as entry script
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('console.ts')) {
  main().catch(err => {
    console.error('Fatal launcher error:', err);
    process.exit(1);
  });
}
