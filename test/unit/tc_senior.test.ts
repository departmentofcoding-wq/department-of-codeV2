import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReviewPrompt,
  parseVerdict,
  detectUncapturedReview,
  SENIOR_HOME_SCREEN_MARKERS,
  resolveSenior,
  findSeniorBinary,
  assignSenior,
  assignSeniorForTask,
  usageHint,
  SENIORS
} from '../../engine/harness/senior.ts';
import { getSeniorDriver, setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { writeJuniorArtifacts, readLatestArtifacts } from '../../engine/harness/junior-artifacts.ts';
import { sliceAfterPrompt } from '../../engine/harness/antigravity.ts';

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

  it('assignSeniorForTask: ONE senior per task — same for plan+walkthrough, deterministic', () => {
    delete process.env.SENIOR_DEFAULT; delete process.env.SENIOR_PLAN; delete process.env.SENIOR_WALKTHROUGH;
    const a = assignSeniorForTask('task-abc-123');
    // Stable across calls (the plan review and the walkthrough review of the same
    // task therefore get the SAME senior — never two seniors on one task's code).
    expect(assignSeniorForTask('task-abc-123')).toBe(a);
    expect(['claude', 'zai']).toContain(a);
  });

  it('assignSeniorForTask: load spreads ACROSS tasks (not all one senior)', () => {
    delete process.env.SENIOR_DEFAULT;
    const picks = new Set(
      Array.from({ length: 24 }, (_, i) => assignSeniorForTask(`task-${i}-xyz`))
    );
    expect(picks.size).toBe(2); // both seniors get used across many tasks
  });

  it('assignSeniorForTask: SENIOR_DEFAULT pins every task to one senior', () => {
    process.env.SENIOR_DEFAULT = 'zai';
    expect(assignSeniorForTask('task-a')).toBe('zai');
    expect(assignSeniorForTask('task-b')).toBe('zai');
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

describe('Senior harness — verdict parsing (genuinely fail-closed)', () => {
  it('reads an explicit VERDICT line', () => {
    expect(parseVerdict('VERDICT: APPROVE\nlooks good').verdict).toBe('approve');
    expect(parseVerdict('VERDICT: APPROVED').verdict).toBe('approve');
    expect(parseVerdict('VERDICT: REVISE\nfix X').verdict).toBe('revise');
    expect(parseVerdict('VERDICT: REJECT\ntoo much').verdict).toBe('revise');
    // The marker may sit anywhere — including the first line of a long review
    // whose tail is all that was captured.
    expect(parseVerdict('VERDICT: APPROVE\n' + 'reasoning\n'.repeat(200)).verdict).toBe('approve');
  });

  it('NEVER approves without an explicit VERDICT marker — approval-sounding prose still revises', () => {
    // This exact shape fail-opened before: "approved" matched the old positive
    // heuristic while none of the negative words did.
    expect(parseVerdict('I do not think this should be approved as-is.').verdict).toBe('revise');
    expect(parseVerdict('This looks good, lgtm.').verdict).toBe('revise');
    expect(parseVerdict('looks good but revise the naming').verdict).toBe('revise');
  });

  it('defaults to revise when ambiguous or empty (never auto-approves garbage)', () => {
    expect(parseVerdict('').verdict).toBe('revise');
    expect(parseVerdict('hmm, I am not sure about this').verdict).toBe('revise');
  });
});

describe('Senior harness — uncaptured-review detection (kills the phantom REVISE loop)', () => {
  // The ZCode/GLM empty home screen, verbatim-ish from a live capture: greeting
  // hero + project picker + composer chrome + template suggestion cards. This is
  // exactly what the harness scraped and fail-closed into a spurious REVISE that
  // re-dispatched the whole task to the junior AND the senior a second time.
  const HOME_SCREEN = [
    'Add context',
    'Full access',
    'Ask before changes Ask before file changes.',
    'Edit automatically Edit files automatically.',
    'Plan mode Plan before editing.',
    'Full access Run with fewer confirmations.',
    'GLM-5.3',
    'High',
    'Send',
    'Summarize the events of the week every Friday.',
    'CI Failures & Flaky Test Report'
  ].join('\n');

  // The ZCode 3.9.2 empty new-task screen as captured LIVE on 2026-08-28 (tail:
  // greeting hero, Select project, hero hint, template cards of that day).
  const LIVE_HOME_SCREEN_3_9_2 = [
    'Good afternoon! Leave the rest to me.',
    'Select project',
    'Ask ZCode anything, @ to add context, / for commands or capabilities',
    'Add context',
    'Full access',
    'GLM-5.3',
    'High',
    'Send',
    'Weekly Summary',
    'Error Fix',
    'PPT Creation',
    'Idle-time task',
    'Update',
    '23'
  ].join('\n');

  it('flags a capture of the empty home screen (multiple chrome markers, no VERDICT)', () => {
    const reason = detectUncapturedReview(HOME_SCREEN);
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/home screen/i);
  });

  it('flags the LIVE-captured 3.9.2 empty new-task screen', () => {
    const reason = detectUncapturedReview(LIVE_HOME_SCREEN_3_9_2);
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/home screen/i);
  });

  it('flags an empty transcript', () => {
    expect(detectUncapturedReview('')).toBeTruthy();
    expect(detectUncapturedReview('   \n  ')).toBeTruthy();
  });

  it('PASSES a genuine review (has a VERDICT line) even if it happens to mention "plan mode"', () => {
    const review =
      'VERDICT: REVISE\nThe plan is missing tests. Also consider whether plan mode is appropriate here.';
    expect(detectUncapturedReview(review)).toBeNull();
  });

  it('PASSES a genuine APPROVE review', () => {
    expect(detectUncapturedReview('VERDICT: APPROVE\nScope is correct; tests enumerated.')).toBeNull();
  });

  it('does NOT trip on a single incidental marker with no VERDICT (conservative)', () => {
    // One marker alone (e.g. a review that says "add context to the error") must
    // not be mistaken for the home screen — the guard requires 2+.
    expect(detectUncapturedReview('The junior should add context to the log lines before merging.')).toBeNull();
  });

  // WS4a scar: "Full access" and "Add context" are PERSISTENT composer chrome in
  // ZCode 3.9.2 (verified live: visible during an active conversation), so a real
  // review capture that merely lacks a clean VERDICT line must NOT be rejected as
  // a home screen just because it quotes that chrome (or the permission labels).
  it('PASSES a genuine verdict-less review that quotes composer chrome (Full access / Add context / permission labels)', () => {
    const review = [
      'The junior set the agent to Full access while editing, which is fine, but they should',
      'Add context to the error handler and pick Ask before changes for destructive steps.',
      'Edit automatically is acceptable inside the sandbox; Plan mode would have been safer.',
      'Overall the walkthrough matches the task, though no explicit verdict marker was produced.'
    ].join('\n');
    expect(detectUncapturedReview(review)).toBeNull();
  });

  it('the home-screen markers are a non-empty set of anchored matchers (live 3.9.2 signals)', () => {
    expect(SENIOR_HOME_SCREEN_MARKERS.length).toBeGreaterThanOrEqual(3);
    // Empty-screen-only signals (live-verified 3.9.2)...
    expect(SENIOR_HOME_SCREEN_MARKERS.some(re => re.test('Good afternoon! Leave the rest to me.'))).toBe(true);
    expect(SENIOR_HOME_SCREEN_MARKERS.some(re => re.test('Select project'))).toBe(true);
    expect(SENIOR_HOME_SCREEN_MARKERS.some(re => re.test('Ask ZCode anything, @ to add context'))).toBe(true);
    // ...and the retired persistent-composer labels are gone from the set.
    expect(SENIOR_HOME_SCREEN_MARKERS.some(re => re.test('Edit automatically'))).toBe(false);
    expect(SENIOR_HOME_SCREEN_MARKERS.some(re => re.test('Full access'))).toBe(false);
    expect(SENIOR_HOME_SCREEN_MARKERS.some(re => re.test('Add context'))).toBe(false);
  });

  // Regression: a CONTINUATION round (rounds 2+) — where the phantom-REVISE incident
  // actually happened — can have a prior round's real `VERDICT:` still in the tail
  // window. The guard must judge the CURRENT round (sliced after the prompt), not the
  // full transcript, or the stale marker bypasses it and the current round's home
  // screen fail-closes to a spurious REVISE. Mirrors ZCodeSenior.review's ordering.
  it('slice-then-guard catches current-round home screen despite a stale VERDICT above it', () => {
    const prompt = 'Review the walkthrough against the task above. Start with the VERDICT line.';
    const full = [
      'VERDICT: APPROVE',                 // an EARLIER round still in the tail window
      'The round-1 walkthrough looked fine.',
      prompt,                             // the current round's prompt boundary
      'Good afternoon! Leave the rest to me.', // ...but the current round captured the
      'Select project',                   // empty home screen, not a review
      'Ask ZCode anything, @ to add context, / for commands or capabilities',
      'Weekly Summary',
      'PPT Creation'
    ].join('\n');

    // The OLD ordering (guard on the full transcript) would be fooled by the stale marker:
    expect(detectUncapturedReview(full)).toBeNull();
    // The FIXED ordering (slice to this round first, then guard) catches it:
    const raw = sliceAfterPrompt(full, prompt) || full;
    expect(detectUncapturedReview(raw)).toBeTruthy();
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

  it('writeJuniorArtifacts SCRUBS secrets before persisting (kept + committed for history)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-art-sec-'));
    try {
      // A junior transcript that echoed an API key and a KEY=value line.
      writeJuniorArtifacts('task-sec', 'disp-x', {
        junior: 'A',
        plan: 'use key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 in the client',
        walkthrough: 'ran with GOOGLE_API_KEY=supersecretvalue123 and it worked',
        fullOutput: 'sk-ant-0123456789abcdef0123456789abcdef in the logs'
      }, base);
      const art = readLatestArtifacts('task-sec', base);
      const all = art.plan + art.walkthrough + art.transcript;
      expect(all).not.toContain('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456');
      expect(all).not.toContain('supersecretvalue123');
      expect(all).not.toContain('sk-ant-0123456789abcdef0123456789abcdef');
      expect(all).toContain('[REDACTED]');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
