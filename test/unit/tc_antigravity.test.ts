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
  resolveDeliveryStrategy,
  buildWorktreeDirective,
  pickFolderWindow,
  pickMainWindow,
  JUNIORS,
  ANTIGRAVITY_DEFAULT_PORT,
  JUNIOR_COMPLETION_INSTRUCTION,
  JUNIOR_COMPLETION_MARKER,
  juniorCompletionEvidence
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

  it('pickFolderWindow matches the window opened ON a worktree by its title', () => {
    // Antigravity titles each window "<folder-basename> - Antigravity IDE" (live).
    const taskId = 'abc123-def';
    const targets = [
      { type: 'page', title: 'Dept of code v2 - Antigravity IDE', webSocketDebuggerUrl: 'ws://main' },
      { type: 'worker', title: '', webSocketDebuggerUrl: 'ws://worker' },
      { type: 'page', title: `${taskId} - Antigravity IDE`, webSocketDebuggerUrl: 'ws://wt' }
    ];
    // A worktree path like <repo>/.bureau-worktrees/<taskId> → basename is the taskId.
    expect(pickFolderWindow(targets, `D:/repo/.bureau-worktrees/${taskId}`)).toBe('ws://wt');
    // Trailing slash is tolerated.
    expect(pickFolderWindow(targets, `D:/repo/.bureau-worktrees/${taskId}/`)).toBe('ws://wt');
  });

  it('pickFolderWindow returns empty when the folder window is not (yet) present', () => {
    const targets = [
      { type: 'page', title: 'Dept of code v2 - Antigravity IDE', webSocketDebuggerUrl: 'ws://main' },
      // A loading window whose title has not populated must NOT be mistaken for ours.
      { type: 'page', title: '', webSocketDebuggerUrl: 'ws://loading' }
    ];
    expect(pickFolderWindow(targets, 'D:/repo/.bureau-worktrees/zzz')).toBe('');
    // Never picks the main window for a different folder.
    expect(pickFolderWindow(targets, 'D:/repo/.bureau-worktrees/zzz')).not.toBe('ws://main');
  });

  it('pickMainWindow excludes worktree windows so plan dispatches never attach to one', () => {
    const taskId = 'task-777';
    const targets = [
      // A per-task worktree window is open (opened by a delivery dispatch)...
      { type: 'page', title: `${taskId} - Antigravity IDE`, url: 'vscode-file://vscode-app/x', webSocketDebuggerUrl: 'ws://wt' },
      // ...and the main repo workbench window.
      { type: 'page', title: 'Dept of code v2 - Antigravity IDE', url: 'vscode-file://vscode-app/y', webSocketDebuggerUrl: 'ws://main' }
    ];
    // With the worktree basename excluded, the MAIN window is chosen even though the
    // worktree window appears first in the list (URL prefixes are identical).
    expect(pickMainWindow(targets, [taskId])).toBe('ws://main');
    // With no exclusions it would wrongly take the first vscode-file:// window.
    expect(pickMainWindow(targets, [])).toBe('ws://wt');
  });

  it('pickMainWindow returns empty when only the loading splash is present', () => {
    expect(pickMainWindow([{ type: 'page', title: '', url: 'data:text/html,splash', webSocketDebuggerUrl: 'ws://splash' }], [])).toBe('');
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

  it('the two juniors declare different window models', () => {
    // A is the VS Code fork (per-folder windows); B is the standalone 2.0 agent
    // app (single window). This is what decides how a delivery reaches the worktree.
    expect(JUNIORS.A.windowModel).toBe('folder-window');
    expect(JUNIORS.B.windowModel).toBe('single-window');
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

// ---------------------------------------------------------------------------------
// Delivery window strategy (N9 fix). A delivery dispatch must reach the task's
// bureau worktree, but the two juniors have DIFFERENT window models: A opens the
// worktree as its own CDP window; B (Antigravity 2.0) has a single window and no
// folder-windows, so it is told the worktree path in the prompt. resolveDeliveryStrategy
// is the pure branch that decides which — the exact code path that, wrong, killed N9.
// ---------------------------------------------------------------------------------
describe('resolveDeliveryStrategy — how each junior reaches the worktree', () => {
  const WT = 'D:/Dept of code v2/.bureau-worktrees/task-9';

  it('junior A (folder-window) on a REQUIRED worktree opens a folder window, no prompt injection', () => {
    const s = resolveDeliveryStrategy(JUNIORS.A, { folder: WT, requireFolder: true });
    expect(s.attach).toBe('folder-window');
    expect(s.injectWorktreePath).toBeUndefined();
  });

  it('junior B (single-window) on a REQUIRED worktree attaches the main window and injects the path', () => {
    // This is the N9 fix: B must NOT try to open a folder window (it has none) —
    // it attaches its single window and the path is prepended to the prompt.
    const s = resolveDeliveryStrategy(JUNIORS.B, { folder: WT, requireFolder: true });
    expect(s.attach).toBe('main-window');
    expect(s.injectWorktreePath).toBe(WT);
  });

  it('a NON-required folder (planning path) never opens a folder window or injects, for either junior', () => {
    for (const cfg of [JUNIORS.A, JUNIORS.B]) {
      const s = resolveDeliveryStrategy(cfg, { folder: WT, requireFolder: false });
      expect(s.attach).toBe('main-window');
      expect(s.injectWorktreePath).toBeUndefined();
    }
  });

  it('no folder at all → main window, no injection (arbitrary command / plan authoring)', () => {
    for (const cfg of [JUNIORS.A, JUNIORS.B]) {
      const s = resolveDeliveryStrategy(cfg, {});
      expect(s.attach).toBe('main-window');
      expect(s.injectWorktreePath).toBeUndefined();
    }
  });
});

describe('buildWorktreeDirective — the path handed to a single-window junior', () => {
  const WT = 'D:/Dept of code v2/.bureau-worktrees/task-9';

  it('names the exact worktree path and confines the agent to it', () => {
    const d = buildWorktreeDirective(WT);
    expect(d).toContain(WT);
    expect(d).toMatch(/cd into/i);
    expect(d).toMatch(/do not (write to|read from|run git)/i); // stay out of the parent repo
  });

  it('prepending it to a department prompt preserves the completion gate', () => {
    // The directive is PREPENDED, so the prompt's last line (the N0 completion
    // instruction) is unchanged and the marker still present — the completion
    // evidence gate must behave exactly as it does without the directive.
    const departmentPrompt = [
      'Your implementation plan was reviewed and APPROVED. Implement it now.',
      '===== APPROVED PLAN =====',
      'work on the checked-out branch; add tests.',
      JUNIOR_COMPLETION_INSTRUCTION
    ].join('\n');
    const effective = buildWorktreeDirective(WT) + departmentPrompt;
    expect(effective).toContain(JUNIOR_COMPLETION_MARKER);
    // Just-echoed effective prompt, no agent output yet → NOT evidence.
    const echoed = [...effective.split('\n'), 'Send message'].join('\n');
    expect(juniorCompletionEvidence(echoed, effective)).toBe(false);
    // Agent prints the sentinel as its final line → evidence, keyed off the
    // (unchanged) last line of the effective prompt.
    const replied = [...effective.split('\n'), 'Done; tests pass.', JUNIOR_COMPLETION_MARKER, 'Send message'].join('\n');
    expect(juniorCompletionEvidence(replied, effective)).toBe(true);
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

  it('a bare timestamp landing MID-plan does not truncate the extracted block', () => {
    // Long generations cross minute boundaries; the stamp must be skipped,
    // not treated as the end of the plan.
    const full = [
      'Implementation Plan',
      '1. add add() to math.js',
      '9:01 PM',
      '2. add a test file test/math.test.ts',
      '3. record mutation evidence',
      'Ask anything, @ to mention'
    ].join('\n');
    const plan = extractPlan(full);
    expect(plan).toContain('add add() to math.js');
    expect(plan).toContain('record mutation evidence'); // the part after the stamp survives
    expect(plan).not.toContain('9:01 PM');
    expect(plan).not.toContain('Ask anything');
  });

  it('returns empty string when no marker is present', () => {
    expect(extractPlan('just a chat reply\nView Usage')).toBe('');
    expect(extractWalkthrough('just a chat reply\nView Usage')).toBe('');
  });

  it('the N0 sentinel line is filtered out of extracted artifacts (harness signal, not content)', () => {
    const full = ['Walkthrough', 'Added add() and a passing test.', JUNIOR_COMPLETION_MARKER, 'Ask anything'].join('\n');
    const walkthrough = extractWalkthrough(full);
    expect(walkthrough).toContain('Added add()');
    expect(walkthrough).not.toContain(JUNIOR_COMPLETION_MARKER);
  });
});

// ---------------------------------------------------------------------------------
// N0 completion evidence — the reply region must be isolated LINE-AWARE. The senior's
// REVISE round 1 caught the original wiring (`extractAgentReply`) false-positiveing on
// the echoed prompt: its needle is the whole multi-line prompt, which can never equal
// or be contained in a single transcript line, so it fell back to the page tail —
// which right after send IS the echoed prompt, instruction block and its marker line.
// These tests use the realistic multi-line department prompt shape.
// ---------------------------------------------------------------------------------
describe('N0 completion evidence — multi-line prompts, echoed prompts, real replies', () => {
  const departmentPrompt = [
    'Your implementation plan was reviewed and APPROVED by a senior. Implement it now, exactly as planned.',
    '',
    '===== TASK =====',
    'TITLE: Build a clicker',
    'INTENT: one button increments a number',
    'SPEC: single HTML page',
    'ACCEPTANCE: clicking raises the count',
    '',
    '===== APPROVED PLAN =====',
    'Branch: wt/x; index.html only; add t_clicker.test.ts.',
    '',
    JUNIOR_COMPLETION_INSTRUCTION
  ].join('\n');

  it('a JUST-ECHOED multi-line prompt (no agent output yet) is NOT completion evidence', () => {
    // The shape of the DOM right after sendPrompt: the echoed prompt followed by
    // composer chrome, before the first token streams.
    const justEchoed = [...departmentPrompt.split('\n'), 'Send message'].join('\n');
    expect(juniorCompletionEvidence(justEchoed, departmentPrompt)).toBe(false);
  });

  it('the agent printing the sentinel as its final line IS completion evidence', () => {
    const replied = [
      ...departmentPrompt.split('\n'),
      'Implemented the button and counter; tests pass (2/2).',
      JUNIOR_COMPLETION_MARKER,
      'Send message'
    ].join('\n');
    expect(juniorCompletionEvidence(replied, departmentPrompt)).toBe(true);
  });

  it('a reply WITHOUT the sentinel is not evidence (the subprocess-gap shape)', () => {
    const turnEndedNoMarker = [
      ...departmentPrompt.split('\n'),
      'I have launched the initial vitest run to verify the baseline. I will monitor it.',
      'Send message'
    ].join('\n');
    expect(juniorCompletionEvidence(turnEndedNoMarker, departmentPrompt)).toBe(false);
  });

  it('prompt scrolled out of the capture window: the marker in the reply still counts', () => {
    // readTranscript windows the tail; if the echoed prompt is gone, the fallback
    // is the whole text — a marker there can only be the agent's own.
    const windowed = ['(long reply scrolled past the prompt…) implementation done', JUNIOR_COMPLETION_MARKER, 'Send message'].join('\n');
    expect(juniorCompletionEvidence(windowed, departmentPrompt)).toBe(true);
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
