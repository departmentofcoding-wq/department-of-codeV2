import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAntigravityArgs,
  findAntigravityBinary,
  isDebugPortLive,
  extractAgentReply,
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

  it('extractAgentReply isolates the reply from IDE chrome (real 2.8.1 shape)', () => {
    const prompt = 'Reply with exactly: PIPELINE OK';
    // Mirrors captured Antigravity text: prompt, timestamp, reply, then chrome.
    const full = [
      'Department Of Code Confirmation',
      'Open IDE',
      prompt,
      '8:34 PM',
      'PIPELINE OK',
      '8:34 PM',
      'Ask anything, @ to mention, / for actions',
      'Gemini 3.7 Flash Medium',
      'View Usage'
    ].join('\n');
    expect(extractAgentReply(full, prompt)).toBe('PIPELINE OK');
  });

  it('extractAgentReply falls back to non-chrome tail when the prompt is absent', () => {
    const full = ['some earlier context', 'The build succeeded.', 'Ask anything, @ to mention', 'Gemini 3.7 Flash'].join('\n');
    expect(extractAgentReply(full, 'a prompt not present')).toContain('The build succeeded.');
  });
});
