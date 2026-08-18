import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAntigravityArgs,
  findAntigravityBinary,
  isDebugPortLive,
  ANTIGRAVITY_DEFAULT_PORT
} from '../../engine/harness/antigravity.ts';

describe('Antigravity integration — deterministic surface', () => {
  const savedPath = process.env.ANTIGRAVITY_PATH;
  afterEach(() => {
    if (savedPath === undefined) delete process.env.ANTIGRAVITY_PATH;
    else process.env.ANTIGRAVITY_PATH = savedPath;
  });

  it('buildAntigravityArgs exposes the debug port', () => {
    expect(buildAntigravityArgs(9333)).toEqual(['--remote-debugging-port=9333']);
    expect(ANTIGRAVITY_DEFAULT_PORT).toBe(9333);
  });

  it('findAntigravityBinary honors ANTIGRAVITY_PATH when it exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'));
    const fake = path.join(tmp, 'Antigravity.exe');
    fs.writeFileSync(fake, '');
    process.env.ANTIGRAVITY_PATH = fake;
    expect(findAntigravityBinary()).toBe(fake);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('isDebugPortLive returns false on a port with no CDP endpoint', async () => {
    // Port 1 is not a live CDP endpoint; must resolve false, not throw.
    await expect(isDebugPortLive(1)).resolves.toBe(false);
  });
});
