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
  SENIORS,
  pickAttachablePage,
  SENIOR_WINDOW_ATTACH_MS,
  buildClaudeSeniorArgs,
  resolveClaudeSeniorAllowedTools,
  resolveClaudeSeniorModel,
  resolveClaudeSeniorFallbackModel,
  parseClaudeStreamJson,
  DEFAULT_CLAUDE_SENIOR_MODEL,
  DEFAULT_CLAUDE_SENIOR_ALLOWED_TOOLS
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
  const saved = {
    d: process.env.SENIOR_DEFAULT,
    p: process.env.SENIOR_PLAN,
    w: process.env.SENIOR_WALKTHROUGH,
    s: process.env.SENIOR_SCALE_DEFAULT
  };
  afterEach(() => {
    for (const [k, v] of [
      ['SENIOR_DEFAULT', saved.d],
      ['SENIOR_PLAN', saved.p],
      ['SENIOR_WALKTHROUGH', saved.w],
      ['SENIOR_SCALE_DEFAULT', saved.s]
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('defaults split the load: plan → claude, walkthrough → zai (never both)', () => {
    delete process.env.SENIOR_DEFAULT;
    delete process.env.SENIOR_PLAN;
    delete process.env.SENIOR_WALKTHROUGH;
    delete process.env.SENIOR_SCALE_DEFAULT;
    expect(assignSenior({ kind: 'plan' })).toBe('claude');
    expect(assignSenior({ kind: 'walkthrough' })).toBe('zai');
  });

  it('SENIOR_DEFAULT overrides both kinds; per-kind env wins over default', () => {
    process.env.SENIOR_DEFAULT = 'zai';
    expect(assignSenior({ kind: 'plan' })).toBe('zai');
    process.env.SENIOR_PLAN = 'claude';
    expect(assignSenior({ kind: 'plan' })).toBe('claude');
  });

  it('SENIOR_SCALE_DEFAULT defaults both plan and walkthrough to chosen senior when no overrides are set', () => {
    delete process.env.SENIOR_DEFAULT;
    delete process.env.SENIOR_PLAN;
    delete process.env.SENIOR_WALKTHROUGH;
    process.env.SENIOR_SCALE_DEFAULT = 'claude';
    expect(assignSenior({ kind: 'plan' })).toBe('claude');
    expect(assignSenior({ kind: 'walkthrough' })).toBe('claude');

    process.env.SENIOR_SCALE_DEFAULT = 'ZAI'; // case-insensitive
    expect(assignSenior({ kind: 'plan' })).toBe('zai');
    expect(assignSenior({ kind: 'walkthrough' })).toBe('zai');
  });

  it('explicit SENIOR_DEFAULT and per-kind overrides win over SENIOR_SCALE_DEFAULT', () => {
    process.env.SENIOR_SCALE_DEFAULT = 'claude';
    process.env.SENIOR_DEFAULT = 'zai';
    expect(assignSenior({ kind: 'plan' })).toBe('zai');
    expect(assignSenior({ kind: 'walkthrough' })).toBe('zai');

    process.env.SENIOR_PLAN = 'claude';
    expect(assignSenior({ kind: 'plan' })).toBe('claude');
    expect(assignSenior({ kind: 'walkthrough' })).toBe('zai');
  });

  it('usageHint distinguishes GUI quota (zai) from CLI (claude)', () => {
    expect(usageHint('zai')).toMatch(/Usage remaining|GUI/i);
    expect(usageHint('claude')).toMatch(/\/usage|console\.anthropic/i);
  });

  it('assignSeniorForTask: ONE senior per task — same for plan+walkthrough, deterministic', () => {
    delete process.env.SENIOR_DEFAULT;
    delete process.env.SENIOR_PLAN;
    delete process.env.SENIOR_WALKTHROUGH;
    delete process.env.SENIOR_SCALE_DEFAULT;
    const a = assignSeniorForTask('task-abc-123');
    // Stable across calls (the plan review and the walkthrough review of the same
    // task therefore get the SAME senior — never two seniors on one task's code).
    expect(assignSeniorForTask('task-abc-123')).toBe(a);
    expect(['claude', 'zai']).toContain(a);
  });

  it('assignSeniorForTask: load spreads ACROSS tasks (not all one senior)', () => {
    delete process.env.SENIOR_DEFAULT;
    delete process.env.SENIOR_SCALE_DEFAULT;
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

  it('assignSeniorForTask: SENIOR_SCALE_DEFAULT sets default senior across all tasks unless SENIOR_DEFAULT overrides', () => {
    delete process.env.SENIOR_DEFAULT;
    process.env.SENIOR_SCALE_DEFAULT = 'claude';
    expect(assignSeniorForTask('task-a')).toBe('claude');
    expect(assignSeniorForTask('task-b')).toBe('claude');

    // SENIOR_DEFAULT still takes highest precedence
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

describe('pickAttachablePage — the cold-start attach page selector (Defect A)', () => {
  // The 2026-08-30 live failure: the FIRST review after ensureSeniorRunning's
  // kill+relaunch died "ZCode main window not found" because attach read
  // /json/list ONCE, before the workbench page target had rendered (~30-40s lag).
  // The selection itself is pure and version-stable; attach now polls it on a
  // SENIOR_WINDOW_ATTACH_MS budget until a page appears.
  it('returns null when no page target exists yet (the cold-start gap attach waits out)', () => {
    expect(pickAttachablePage([])).toBeNull();
    // A debug port that only exposes worker/other targets is the exact cold gap.
    expect(pickAttachablePage([{ type: 'worker', webSocketDebuggerUrl: 'ws://x' }])).toBeNull();
    // A page with no ws url is not attachable.
    expect(pickAttachablePage([{ type: 'page', url: 'file:///a', webSocketDebuggerUrl: '' }])).toBeNull();
  });

  it('selects the packaged renderer page served from file:/// (the real 3.9.2 shape)', () => {
    // Live-observed 2026-08-30: ZCode 3.9.2 serves its workbench from
    // file:///…/app.asar/out/renderer/index.html — matched by the non-data: fallback.
    const targets = [
      { type: 'page', url: 'data:text/html,devtools', webSocketDebuggerUrl: 'ws://d' },
      { type: 'worker', url: 'file:///w', webSocketDebuggerUrl: 'ws://w' },
      { type: 'page', url: 'file:///C:/Users/x/AppData/Local/Programs/ZCode/resources/app.asar/out/renderer/index.html', webSocketDebuggerUrl: 'ws://page' }
    ];
    expect(pickAttachablePage(targets)?.webSocketDebuggerUrl).toBe('ws://page');
  });

  it('prefers the loopback dev page, then vscode-file://, over a generic file page', () => {
    const targets = [
      { type: 'page', url: 'file:///generic', webSocketDebuggerUrl: 'ws://file' },
      { type: 'page', url: 'vscode-file://vscode-app/index.html', webSocketDebuggerUrl: 'ws://vscode' },
      { type: 'page', url: 'https://127.0.0.1:9335/workbench', webSocketDebuggerUrl: 'ws://loopback' }
    ];
    expect(pickAttachablePage(targets)?.webSocketDebuggerUrl).toBe('ws://loopback');
    expect(pickAttachablePage(targets.slice(0, 2))?.webSocketDebuggerUrl).toBe('ws://vscode');
    expect(pickAttachablePage(targets.slice(0, 1))?.webSocketDebuggerUrl).toBe('ws://file');
  });

  it('never selects a data: page (DevTools/blank), even if it is the only page', () => {
    expect(pickAttachablePage([{ type: 'page', url: 'data:text/html,x', webSocketDebuggerUrl: 'ws://d' }])).toBeNull();
  });

  it('exposes a generous cold-start attach budget', () => {
    expect(SENIOR_WINDOW_ATTACH_MS).toBeGreaterThanOrEqual(40000);
  });
});

describe('Claude CLI senior — efficiency levers (read-only tools, cheap model, usage capture)', () => {
  const KEYS = [
    'CLAUDE_SENIOR_ALLOWED_TOOLS',
    'CLAUDE_SENIOR_MODEL',
    'CLAUDE_SENIOR_DIFF_MODEL',
    'CLAUDE_SENIOR_FALLBACK_MODEL'
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults the allowed toolset to read-only navigation (no Bash, no writes)', () => {
    delete process.env['CLAUDE_SENIOR_ALLOWED_TOOLS'];
    const tools = resolveClaudeSeniorAllowedTools();
    expect(tools).toEqual(DEFAULT_CLAUDE_SENIOR_ALLOWED_TOOLS);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Write');
  });

  it('honors a CLAUDE_SENIOR_ALLOWED_TOOLS override (space/comma separated)', () => {
    expect(resolveClaudeSeniorAllowedTools({ CLAUDE_SENIOR_ALLOWED_TOOLS: 'Read, Bash Grep' } as any)).toEqual([
      'Read',
      'Bash',
      'Grep'
    ]);
  });

  it('defaults the review model to Opus 4.8 (operator-pinned quality gate)', () => {
    delete process.env['CLAUDE_SENIOR_MODEL'];
    delete process.env['CLAUDE_SENIOR_DIFF_MODEL'];
    expect(resolveClaudeSeniorModel({ kind: 'plan' }, undefined)).toBe(DEFAULT_CLAUDE_SENIOR_MODEL);
    expect(DEFAULT_CLAUDE_SENIOR_MODEL).toBe('claude-opus-4-8');
  });

  it('model precedence: explicit call > per-kind diff override > instance model (= ctor/CLAUDE_SENIOR_MODEL) > default', () => {
    // The instance model already folds in the constructor arg / CLAUDE_SENIOR_MODEL
    // (ClaudeCliSenior sets this.model = arg ?? env.CLAUDE_SENIOR_MODEL), so it is
    // passed in as `instanceModel`. Only the per-kind diff override is read from env here.
    const env = { CLAUDE_SENIOR_DIFF_MODEL: 'diff-model' } as any;
    // explicit call model wins everywhere
    expect(resolveClaudeSeniorModel({ kind: 'diff', model: 'call-model' }, 'inst-model', env)).toBe('call-model');
    // diff override applies ONLY to the diff/merge gate
    expect(resolveClaudeSeniorModel({ kind: 'diff' }, 'inst-model', env)).toBe('diff-model');
    // non-diff kinds ignore the diff override and take the instance model
    expect(resolveClaudeSeniorModel({ kind: 'plan' }, 'inst-model', env)).toBe('inst-model');
    // no instance model, no override -> the cheap default
    expect(resolveClaudeSeniorModel({ kind: 'walkthrough' }, undefined, env)).toBe(DEFAULT_CLAUDE_SENIOR_MODEL);
  });

  it('resolves an optional fallback model only when set', () => {
    expect(resolveClaudeSeniorFallbackModel({} as any)).toBeUndefined();
    expect(resolveClaudeSeniorFallbackModel({ CLAUDE_SENIOR_FALLBACK_MODEL: '  claude-haiku-4-5  ' } as any)).toBe(
      'claude-haiku-4-5'
    );
  });

  it('builds argv with stream-json output, the read-only allowlist, and the model', () => {
    const args = buildClaudeSeniorArgs({
      system: 'SYS',
      model: 'claude-sonnet-5',
      allowedTools: ['Read', 'Grep', 'Glob'],
      fallbackModel: 'claude-haiku-4-5'
    });
    expect(args).toContain('-p');
    // structured output so usage is captured and the guard stays fed
    expect(args.join(' ')).toContain('--output-format stream-json');
    // read-only allowlist passed as a single token so it can't swallow later flags
    const ai = args.indexOf('--allowedTools');
    expect(ai).toBeGreaterThan(-1);
    expect(args[ai + 1]).toBe('Read Grep Glob');
    expect(args[ai + 1]).not.toContain('Bash');
    // model + fallback present
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    expect(args[args.indexOf('--fallback-model') + 1]).toBe('claude-haiku-4-5');
    // the appended system prompt is preserved
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYS');
  });

  it('omits the allowlist flag when no tools are allowed, and the fallback flag when unset', () => {
    const args = buildClaudeSeniorArgs({ system: 'S', model: 'm', allowedTools: [] });
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--fallback-model');
  });

  it('parses stream-json: final result text + token/cost usage', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking...' }] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'VERDICT: APPROVE\nLooks correct.',
        session_id: 's1',
        total_cost_usd: 0.0123,
        num_turns: 2,
        usage: { input_tokens: 1500, output_tokens: 300, cache_read_input_tokens: 100 }
      })
    ].join('\n');
    const { text, usage } = parseClaudeStreamJson(stdout);
    expect(text).toContain('VERDICT: APPROVE');
    expect(usage?.inputTokens).toBe(1500);
    expect(usage?.outputTokens).toBe(300);
    expect(usage?.cacheReadTokens).toBe(100);
    expect(usage?.costUsd).toBeCloseTo(0.0123);
    expect(usage?.sessionId).toBe('s1');
    // the parsed result feeds parseVerdict cleanly
    expect(parseVerdict(text).verdict).toBe('approve');
  });

  it('parses stream-json: stitches assistant text when there is no result event', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: REVISE' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'fix the guard.' }] } })
    ].join('\n');
    const { text, usage } = parseClaudeStreamJson(stdout);
    expect(text).toContain('VERDICT: REVISE');
    expect(usage).toBeUndefined();
  });

  it('parses stream-json: returns empty text on non-JSON stdout so the caller can fall back to raw', () => {
    const { text, usage } = parseClaudeStreamJson('plain text VERDICT: APPROVE, no json here');
    expect(text).toBe('');
    expect(usage).toBeUndefined();
  });

  it('is robust to interleaved non-JSON lines', () => {
    const stdout = [
      'warning: something on stderr merged in',
      JSON.stringify({ type: 'result', result: 'VERDICT: APPROVE', usage: { input_tokens: 10, output_tokens: 5 } }),
      'trailing noise'
    ].join('\n');
    const { text, usage } = parseClaudeStreamJson(stdout);
    expect(text).toBe('VERDICT: APPROVE');
    expect(usage?.inputTokens).toBe(10);
  });
});
