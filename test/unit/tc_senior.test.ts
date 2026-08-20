import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReviewPrompt,
  parseVerdict,
  resolveSenior,
  findSeniorBinary,
  assignSenior,
  usageHint,
  SENIORS
} from '../../engine/harness/senior.ts';
import { getSeniorDriver, setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { writeJuniorArtifacts, readLatestArtifacts } from '../../engine/harness/junior-artifacts.ts';

describe('Senior harness — registry', () => {
  it('resolves both seniors; claude is a CLI, zai is a CDP GUI', () => {
    expect(resolveSenior('claude').kind).toBe('cli');
    expect(resolveSenior('zai').kind).toBe('cdp');
    expect(resolveSenior('ZAI').id).toBe('zai'); // case-insensitive
    expect(resolveSenior(undefined).id).toBe('claude'); // default
    expect(SENIORS.zai.cdpPort).toBe(9335);
  });

  it('resolveSenior throws on an unknown id', () => {
    expect(() => resolveSenior('grok')).toThrow(/Unknown senior/);
  });

  it('findSeniorBinary honors env override, else accepts a bare PATH command', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-'));
    const fake = path.join(tmp, 'claude.cmd');
    fs.writeFileSync(fake, '');
    const saved = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = fake;
    try {
      expect(findSeniorBinary(SENIORS.claude)).toBe(fake);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Senior harness — single-reviewer assignment (one senior per review)', () => {
  const saved = { d: process.env.SENIOR_DEFAULT, p: process.env.SENIOR_PLAN, w: process.env.SENIOR_WALKTHROUGH };
  afterEach(() => {
    for (const [k, v] of [['SENIOR_DEFAULT', saved.d], ['SENIOR_PLAN', saved.p], ['SENIOR_WALKTHROUGH', saved.w]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('defaults split the load: plan → claude, walkthrough → zai (never both)', () => {
    delete process.env.SENIOR_DEFAULT; delete process.env.SENIOR_PLAN; delete process.env.SENIOR_WALKTHROUGH;
    expect(assignSenior({ kind: 'plan' })).toBe('claude');
    expect(assignSenior({ kind: 'walkthrough' })).toBe('zai');
  });

  it('SENIOR_DEFAULT overrides both kinds; per-kind env wins over default', () => {
    process.env.SENIOR_DEFAULT = 'zai';
    expect(assignSenior({ kind: 'plan' })).toBe('zai');
    process.env.SENIOR_PLAN = 'claude';
    expect(assignSenior({ kind: 'plan' })).toBe('claude');
  });

  it('usageHint distinguishes GUI quota (zai) from CLI (claude)', () => {
    expect(usageHint('zai')).toMatch(/Usage remaining|GUI/i);
    expect(usageHint('claude')).toMatch(/\/usage|console\.anthropic/i);
  });
});

describe('Senior harness — prompt building (seniors review, do not code)', () => {
  it('builds a plan-review prompt that forbids coding and demands a VERDICT line', () => {
    const { system, user } = buildReviewPrompt({
      kind: 'plan',
      taskTitle: 'build a clicker',
      plan: '1. index.html — one button'
    });
    expect(system).toMatch(/do NOT write code/i);
    expect(system).toMatch(/VERDICT: APPROVE.*VERDICT: REVISE/i);
    expect(user).toContain('IMPLEMENTATION PLAN');
    expect(user).toContain('index.html — one button');
  });

  it('walkthrough kind embeds the walkthrough text', () => {
    const { user } = buildReviewPrompt({
      kind: 'walkthrough',
      taskTitle: 't',
      walkthrough: 'Created index.html; 0->1 on click.'
    });
    expect(user).toContain('WALKTHROUGH');
    expect(user).toContain('0->1 on click');
  });
});

describe('Senior harness — verdict parsing (fail-closed)', () => {
  it('reads an explicit VERDICT line', () => {
    expect(parseVerdict('VERDICT: APPROVE\nlooks good').verdict).toBe('approve');
    expect(parseVerdict('VERDICT: APPROVED').verdict).toBe('approve');
    expect(parseVerdict('VERDICT: REVISE\nfix X').verdict).toBe('revise');
    expect(parseVerdict('VERDICT: REJECT\ntoo much').verdict).toBe('revise');
  });

  it('falls back to approve only on clear approval language', () => {
    expect(parseVerdict('This looks good, lgtm.').verdict).toBe('approve');
    expect(parseVerdict('looks good but revise the naming').verdict).toBe('revise');
  });

  it('defaults to revise when ambiguous or empty (never auto-approves garbage)', () => {
    expect(parseVerdict('').verdict).toBe('revise');
    expect(parseVerdict('hmm, I am not sure about this').verdict).toBe('revise');
  });
});

describe('Senior harness — seam + artifact reading', () => {
  afterEach(() => setSeniorDriverOverride(null));

  it('getSeniorDriver honors a test override so the flow runs without a live senior', async () => {
    setSeniorDriverOverride({
      review: async input => ({
        senior: 'fake',
        verdict: 'approve',
        feedback: `saw ${input.kind}`,
        raw: 'VERDICT: APPROVE'
      })
    });
    const v = await getSeniorDriver('claude').review({ kind: 'plan', taskTitle: 't', plan: 'p' });
    expect(v.verdict).toBe('approve');
    expect(v.feedback).toBe('saw plan');
  });

  it('readLatestArtifacts returns the newest run’s plan/walkthrough for a senior to review', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-art-'));
    try {
      writeJuniorArtifacts('task-9', 'disp-1', {
        junior: 'B',
        plan: 'the plan',
        walkthrough: 'the walkthrough',
        fullOutput: 'everything',
        reply: 'ok'
      }, base);
      const art = readLatestArtifacts('task-9', base);
      expect(art.plan).toContain('the plan');
      expect(art.walkthrough).toContain('the walkthrough');
      expect(art.dir).toContain(path.join('junior-artifacts', 'task-9'));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('readLatestArtifacts returns empties for an unknown task', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-art0-'));
    try {
      const art = readLatestArtifacts('nope', base);
      expect(art).toEqual({ dir: '', plan: '', walkthrough: '', transcript: '', reply: '' });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
