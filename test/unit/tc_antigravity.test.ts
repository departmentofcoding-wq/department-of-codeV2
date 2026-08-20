import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAntigravityArgs,
  findAntigravityBinary,
  findJuniorBinary,
  assignJunior,
  isDebugPortLive,
  extractAgentReply,
  extractPlan,
  extractWalkthrough,
  resolveJunior,
  JUNIORS,
  ANTIGRAVITY_DEFAULT_PORT
} from '../../engine/harness/antigravity.ts';
import { writeJuniorArtifacts } from '../../engine/harness/junior-artifacts.ts';

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

describe('Two-junior registry (A = IDE, B = 2.0)', () => {
  it('resolves both juniors with distinct ports and binaries', () => {
    expect(resolveJunior('A').cdpPort).toBe(9333);
    expect(resolveJunior('B').cdpPort).toBe(9334);
    expect(resolveJunior('b').id).toBe('B'); // case-insensitive
    expect(resolveJunior(undefined).id).toBe('A'); // default
    expect(JUNIORS.A.envPath).toBe('ANTIGRAVITY_IDE_PATH');
    expect(JUNIORS.B.envPath).toBe('ANTIGRAVITY_2_PATH');
  });

  it('resolveJunior throws on an unknown id', () => {
    expect(() => resolveJunior('Z')).toThrow(/Unknown junior/);
  });

  it('assignJunior gives ONE junior per task, stable per task, spread across tasks', () => {
    const saved = process.env.JUNIOR_DEFAULT;
    delete process.env.JUNIOR_DEFAULT;
    try {
      // Stable: same task id always maps to the same junior.
      const a1 = assignJunior({ taskId: 'task-abc' });
      const a2 = assignJunior({ taskId: 'task-abc' });
      expect(a1).toBe(a2);
      expect(['A', 'B']).toContain(a1);
      // Spread: across many task ids, both juniors get used (parallelism).
      const seen = new Set(Array.from({ length: 20 }, (_, i) => assignJunior({ taskId: 'task-' + i })));
      expect(seen.size).toBe(2);
      // prefer + env override force a single junior.
      expect(assignJunior({ taskId: 'x', prefer: 'B' })).toBe('B');
      process.env.JUNIOR_DEFAULT = 'A';
      expect(assignJunior({ taskId: 'anything' })).toBe('A');
    } finally {
      if (saved === undefined) delete process.env.JUNIOR_DEFAULT;
      else process.env.JUNIOR_DEFAULT = saved;
    }
  });

  it('findJuniorBinary honors the per-junior env override', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agb-'));
    const fake = path.join(tmp, 'Antigravity.exe');
    fs.writeFileSync(fake, '');
    const saved = process.env.ANTIGRAVITY_2_PATH;
    process.env.ANTIGRAVITY_2_PATH = fake;
    try {
      expect(findJuniorBinary(JUNIORS.B)).toBe(fake);
    } finally {
      if (saved === undefined) delete process.env.ANTIGRAVITY_2_PATH;
      else process.env.ANTIGRAVITY_2_PATH = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Plan / walkthrough artifact extraction', () => {
  it('extractPlan isolates the plan block, extractWalkthrough the walkthrough', () => {
    const full = [
      'add a function add(a,b)',
      '8:34 PM',
      'Implementation Plan',
      '1. add add() to math.js',
      '2. add a test',
      'Walkthrough',
      'Added add() and a passing test.',
      'Ask anything, @ to mention',
      'Gemini 3.7 Flash'
    ].join('\n');
    expect(extractPlan(full)).toContain('Implementation Plan');
    expect(extractPlan(full)).toContain('add add() to math.js');
    // plan stops before chrome, but here it runs into the walkthrough heading
    expect(extractWalkthrough(full)).toContain('Walkthrough');
    expect(extractWalkthrough(full)).toContain('Added add() and a passing test.');
  });

  it('returns empty string when no marker is present', () => {
    expect(extractPlan('just a chat reply\nView Usage')).toBe('');
    expect(extractWalkthrough('just a chat reply\nView Usage')).toBe('');
  });
});

describe('Junior artifact persistence', () => {
  it('writes only the non-empty artifacts, under a per-task dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-art-'));
    try {
      const { dir, files } = writeJuniorArtifacts(
        'task-1',
        'disp-1',
        { junior: 'B', plan: 'the plan', walkthrough: '', fullOutput: 'everything', reply: 'ok' },
        base
      );
      expect(dir).toContain(path.join('docs', 'junior-artifacts', 'task-1'));
      expect(Object.keys(files).sort()).toEqual(['plan.md', 'reply.md', 'transcript.md']);
      expect(fs.readFileSync(files['plan.md'], 'utf8')).toContain('the plan');
      expect(files['walkthrough.md']).toBeUndefined(); // empty → skipped
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('writes nothing when all artifacts are empty', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-art0-'));
    try {
      const { files } = writeJuniorArtifacts('t', 'd', { plan: '', walkthrough: '', fullOutput: '' }, base);
      expect(Object.keys(files)).toEqual([]);
      expect(fs.existsSync(path.join(base, 'docs', 'junior-artifacts', 't'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
