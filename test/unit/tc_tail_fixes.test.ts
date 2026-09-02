import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { Runner } from '../../runner/main.ts';
import { GhCliPrProvider } from '../../engine/delivery/gh_cli_pr_provider.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { getPrProvider, getPrProviderOverride, setPrProviderOverride } from '../../engine/contract/pr-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { DEFAULT_CLAUDE_SENIOR_TIMEOUT_MS, resolveClaudeSeniorTimeoutMs } from '../../engine/harness/senior.ts';
import { extractPlan, PLAN_MARKERS } from '../../engine/harness/antigravity.ts';
import { runWorkReviewCycle } from '../../engine/flow/work_review_cycle.ts';
import { buildJuniorPlanPrompt, buildImplementationPrompt } from '../../engine/flow/plan_review_cycle.ts';
import { evaluatePlanRubric } from '../../engine/review/plan_review_job.ts';
import { handlePrCreate } from '../../engine/delivery/pr_create.ts';
import { createSession } from '../../engine/intake/index.ts';
import { resolveIntakeSession } from '../../scripts/intake.ts';
import type { BureauTaskRow, BureauWorkReviewRow } from '../../engine/contract/types.ts';

describe('Phase 8 Entry Fix Pack (F1-F6): Delivery-Tail Drill Scar Fixes', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    setPrProviderOverride(null);
    setWorkspaceProvider(null);
    setSeniorDriverOverride(null);
  });

  afterEach(() => {
    setPrProviderOverride(null);
    setWorkspaceProvider(null);
    setSeniorDriverOverride(null);
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
  });

  // =========================================================================
  // F1: Wire PR provider at boot in Runner constructor
  // =========================================================================
  describe('F1: PR provider wiring at boot', () => {
    it('Runner constructor wires GhCliPrProvider when override is null', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f1-'));
      const db = openDbConnection(path.join(tempDir, 'test.db'));

      expect(getPrProviderOverride()).toBeNull();
      new Runner(db);
      expect(getPrProviderOverride()).toBeInstanceOf(GhCliPrProvider);
      expect(getPrProvider()).toBeInstanceOf(GhCliPrProvider);
    });

    it('Runner constructor preserves existing PR provider override', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f1-'));
      const db = openDbConnection(path.join(tempDir, 'test.db'));

      const fake = new FakePrProvider();
      setPrProviderOverride(fake);
      new Runner(db);
      expect(getPrProviderOverride()).toBe(fake);
      expect(getPrProvider()).toBe(fake);
    });

    it('getPrProvider stays fail-closed when uninitialized', () => {
      setPrProviderOverride(null);
      expect(getPrProviderOverride()).toBeNull();
      expect(() => getPrProvider()).toThrow('PR provider has not been initialized or registered.');
    });
  });

  // =========================================================================
  // F2: Record reviewed_commit whenever a worktree row exists
  // =========================================================================
  describe('F2: Record reviewed_commit when worktree row exists (provider-free)', () => {
    it('records reviewed_commit on APPROVE when worktree row exists even without workspace provider', async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f2-'));
      const wtDir = path.join(tempDir, 'wt');
      fs.mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: wtDir, stdio: 'ignore' });
      execSync('git config user.email "test@bureau.local"', { cwd: wtDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(wtDir, 'README.md'), '# F2 Test\n');
      execSync('git add .', { cwd: wtDir, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: wtDir, stdio: 'ignore' });
      const tipHash = execSync('git rev-parse HEAD', { cwd: wtDir, encoding: 'utf8' }).trim();

      const db = openDbConnection(path.join(tempDir, 'test.db'));
      const taskId = 'task-f2-approve';
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verify_fixes, cycles, priority, work_uuid, created_at, updated_at)
         VALUES (?, 'F2 task', 'claimed', 0, 0, 1, 'wuuid-f2', ?, ?)`,
        taskId, now, now
      );

      db.run(
        `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model)
         VALUES ('wt-f2', ?, ?, ?, 'ready', ?, ?, 'junior-engineer', 'git', 'local')`,
        taskId, wtDir, tipHash, now, now
      );

      setWorkspaceProvider(null); // Ensure NO workspace provider is registered
      setSeniorDriverOverride({
        review: async () => ({ senior: 'zai', verdict: 'approve', feedback: 'LGTM', raw: 'VERDICT: APPROVE', model: 'glm-test' })
      } as any);

      const result = await runWorkReviewCycle(db, {
        taskId,
        walkthrough: '## Walkthrough\nDid the work and verified.',
        seniorId: 'zai'
      });

      expect(result.outcome).toBe('approved');

      // Verify reviewed_commit recorded in bureau_work_reviews
      const reviewRow = db.get<BureauWorkReviewRow>(
        'SELECT * FROM bureau_work_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
        taskId
      );
      expect(reviewRow).toBeDefined();
      expect(reviewRow?.reviewed_commit).toBe(tipHash);

      // Verify system journal span recorded
      const spans = db.all<{ kind: string; detail: string }>(
        "SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'system'",
        taskId
      );
      expect(spans.some(s => s.detail.includes('reviewed_commit_recorded'))).toBe(true);
    });

    it('emits guardrail span when NO worktree row exists and leaves reviewed_commit null', async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f2-nowt-'));
      const db = openDbConnection(path.join(tempDir, 'test.db'));
      const taskId = 'task-f2-nowt';
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verify_fixes, cycles, priority, work_uuid, created_at, updated_at)
         VALUES (?, 'F2 task no wt', 'claimed', 0, 0, 1, 'wuuid-f2-nowt', ?, ?)`,
        taskId, now, now
      );

      setSeniorDriverOverride({
        review: async () => ({ senior: 'zai', verdict: 'approve', feedback: 'LGTM', raw: 'VERDICT: APPROVE', model: 'glm-test' })
      } as any);

      const result = await runWorkReviewCycle(db, {
        taskId,
        walkthrough: '## Walkthrough\nNo worktree was needed.',
        seniorId: 'zai'
      });

      expect(result.outcome).toBe('approved');

      const reviewRow = db.get<BureauWorkReviewRow>(
        'SELECT * FROM bureau_work_reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
        taskId
      );
      expect(reviewRow?.reviewed_commit).toBeNull();

      const guardrailSpans = db.all<{ detail: string }>(
        "SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'",
        taskId
      );
      expect(guardrailSpans.some(s => s.detail.includes('no_worktree_row_for_task'))).toBe(true);
    });

    it('fails loudly with guardrail span when worktree row exists but git read fails', async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f2-fail-'));
      const db = openDbConnection(path.join(tempDir, 'test.db'));
      const taskId = 'task-f2-fail';
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verify_fixes, cycles, priority, work_uuid, created_at, updated_at)
         VALUES (?, 'F2 task git fail', 'claimed', 0, 0, 1, 'wuuid-f2-fail', ?, ?)`,
        taskId, now, now
      );

      // Point worktree path to a non-git directory
      const emptyDir = path.join(tempDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      db.run(
        `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model)
         VALUES ('wt-f2-fail', ?, ?, 'base123', 'ready', ?, ?, 'junior-engineer', 'git', 'local')`,
        taskId, emptyDir, now, now
      );

      setSeniorDriverOverride({
        review: async () => ({ senior: 'zai', verdict: 'approve', feedback: 'LGTM', raw: 'VERDICT: APPROVE', model: 'glm-test' })
      } as any);

      await expect(runWorkReviewCycle(db, {
        taskId,
        walkthrough: '## Walkthrough\nDone.',
        seniorId: 'zai'
      })).rejects.toThrow(/Failed to record reviewed_commit/);

      const guardrailSpans = db.all<{ detail: string }>(
        "SELECT * FROM bureau_journal WHERE task_id = ? AND kind = 'guardrail'",
        taskId
      );
      expect(guardrailSpans.some(s => s.detail.includes('reviewed_commit_failed'))).toBe(true);
    });
  });

  // =========================================================================
  // F3: One-branch model both sides
  // =========================================================================
  describe('F3: One-branch model (prompts + pr_create refspec)', () => {
    it('buildJuniorPlanPrompt specifies checked-out branch bureau-wt-<taskId> and no branch switching', () => {
      const task = { id: 'task-f3-plan', title: 'Plan Task' } as BureauTaskRow;
      const prompt = buildJuniorPlanPrompt(task);
      expect(prompt).toContain('work directly on the branch already checked out in the worktree (bureau-wt-task-f3-plan); do not create, switch, or rename branches');
    });

    it('buildImplementationPrompt specifies checked-out branch bureau-wt-<taskId> and no branch switching', () => {
      const task = { id: 'task-f3-impl', title: 'Impl Task' } as BureauTaskRow;
      const prompt = buildImplementationPrompt(task, '## Plan text');
      expect(prompt).toContain('Rules: work directly on the branch already checked out in the worktree (bureau-wt-task-f3-impl); do not create, switch, or rename branches');
    });

    it('pr_create pushes HEAD:refs/heads/bureau-wt-<taskId> refspec', async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f3-pr-'));
      const wtDir = path.join(tempDir, 'wt');
      fs.mkdirSync(wtDir, { recursive: true });
      execSync('git init', { cwd: wtDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: wtDir, stdio: 'ignore' });
      execSync('git config user.email "test@bureau.local"', { cwd: wtDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(wtDir, 'README.md'), '# F3 PR\n');
      execSync('git add .', { cwd: wtDir, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: wtDir, stdio: 'ignore' });
      const tipHash = execSync('git rev-parse HEAD', { cwd: wtDir, encoding: 'utf8' }).trim();

      const db = openDbConnection(path.join(tempDir, 'test.db'));
      const taskId = 'task-f3-pr';
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, approved_at, approved_by, work_uuid, created_at, updated_at)
         VALUES (?, 'F3 PR task', 'needs-review', 0, ?, 'operator', 'wuuid-f3-pr', ?, ?)`,
        taskId, now, now, now
      );

      db.run(
        `INSERT INTO bureau_worktrees (id, task_id, path, base_commit, status, created_at, updated_at, actor_role, provider, model)
         VALUES ('wt-f3-pr', ?, ?, ?, 'ready', ?, ?, 'junior-engineer', 'git', 'local')`,
        taskId, wtDir, tipHash, now, now
      );

      db.run(
        `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, reviewed_commit, actor_role, provider, model, created_at)
         VALUES ('wr-f3', ?, 'wuuid-f3-pr', 'phase4', 1, 'approved', ?, 'senior-engineer', 'zai', 'glm', ?)`,
        taskId, tipHash, now
      );

      const fakePr = new FakePrProvider();
      setPrProviderOverride(fakePr);

      await handlePrCreate({
        db,
        job: { id: 'job-f3-pr', kind: 'pr.create', task_id: taskId } as any,
        payload: { taskId },
        signal: new AbortController().signal
      });

      expect(fakePr.pushedBranches).toContain(`HEAD:refs/heads/bureau-wt-${taskId}`);
      expect(fakePr.createdPrs[0].branch).toBe(`bureau-wt-${taskId}`);
    });
  });

  // =========================================================================
  // F4: Claude Senior timeout default 1200000ms (20 min — operator-set headroom)
  // =========================================================================
  describe('F4: Claude Senior timeout default', () => {
    it('DEFAULT_CLAUDE_SENIOR_TIMEOUT_MS is 1200000ms', () => {
      expect(DEFAULT_CLAUDE_SENIOR_TIMEOUT_MS).toBe(1200000);
    });

    it('resolveClaudeSeniorTimeoutMs defaults to 1200000ms and honors env override', () => {
      expect(resolveClaudeSeniorTimeoutMs({})).toBe(1200000);
      expect(resolveClaudeSeniorTimeoutMs({ CLAUDE_SENIOR_TIMEOUT_MS: '450000' })).toBe(450000);

      const origEnv = process.env['CLAUDE_SENIOR_TIMEOUT_MS'];
      try {
        delete process.env['CLAUDE_SENIOR_TIMEOUT_MS'];
        expect(resolveClaudeSeniorTimeoutMs()).toBe(1200000);

        process.env['CLAUDE_SENIOR_TIMEOUT_MS'] = '123456';
        expect(resolveClaudeSeniorTimeoutMs()).toBe(123456);
      } finally {
        if (origEnv !== undefined) {
          process.env['CLAUDE_SENIOR_TIMEOUT_MS'] = origEnv;
        } else {
          delete process.env['CLAUDE_SENIOR_TIMEOUT_MS'];
        }
      }
    });
  });

  // =========================================================================
  // F5: Intake CLI fresh session by default
  // =========================================================================
  describe('F5: Intake CLI session resolution (scripts/intake.ts)', () => {
    it('creates fresh session by default when open sessions exist unless --continue or --session is passed', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-f5-'));
      const db = openDbConnection(path.join(tempDir, 'test.db'));

      // Seed an existing open session using the engine's createSession
      const existingSession = createSession(db, {
        title: 'Existing Open Session',
        attribution: {
          actor_role: 'human-operator',
          provider: 'deterministic',
          model: 'core',
          account: 'operator'
        }
      });

      // 1. Default: creates a fresh session even when open sessions exist
      const resDefault = resolveIntakeSession(db, {}, ['Brand new task']);
      expect(resDefault.mode).toBe('fresh');
      expect(resDefault.isNew).toBe(true);
      expect(resDefault.sessionId).not.toBe(existingSession.id);

      // 2. With --continue: adopts newest open session
      const resContinue = resolveIntakeSession(db, { continue: true }, ['Follow-up message']);
      expect(resContinue.mode).toBe('continue');
      expect(resContinue.isNew).toBe(false);
      // The newest open session is the one just created by resDefault
      expect(resContinue.sessionId).toBe(resDefault.sessionId);

      // 3. With explicit --session: uses specified session
      const resExplicit = resolveIntakeSession(db, { session: existingSession.id }, ['Explicit msg']);
      expect(resExplicit.mode).toBe('explicit');
      expect(resExplicit.isNew).toBe(false);
      expect(resExplicit.sessionId).toBe(existingSession.id);
    });
  });

  // =========================================================================
  // F6: Junior plan format enforcement & PLAN_MARKERS
  // =========================================================================
  describe('F6: Junior plan format enforcement', () => {
    it('PLAN_MARKERS matches # Implementation Plan as well as ## Plan', () => {
      expect(PLAN_MARKERS.some(m => m.test('# Implementation Plan'))).toBe(true);
      expect(PLAN_MARKERS.some(m => m.test('## Implementation Plan'))).toBe(true);
      expect(PLAN_MARKERS.some(m => m.test('### Implementation Plan'))).toBe(true);
      expect(PLAN_MARKERS.some(m => m.test('# Plan'))).toBe(true);
      expect(PLAN_MARKERS.some(m => m.test('## Plan'))).toBe(true);
      expect(PLAN_MARKERS.some(m => m.test('Implementation Plan'))).toBe(true);
    });

    it('extractPlan correctly extracts plan when junior uses # Implementation Plan', () => {
      const rawOutput = [
        '# Implementation Plan',
        '## Branch',
        'bureau-wt-1234',
        '## Scope',
        'Fix delivery tail',
        'Ask anything, @ to mention'
      ].join('\n');
      const plan = extractPlan(rawOutput);
      expect(plan).toContain('# Implementation Plan');
      expect(plan).toContain('bureau-wt-1234');
      expect(plan).not.toContain('Ask anything');
    });

    it('buildJuniorPlanPrompt specifies top-level header format and rejects conversational text', () => {
      const task = { id: 'task-f6', title: 'F6 Task' } as BureauTaskRow;
      const prompt = buildJuniorPlanPrompt(task);
      expect(prompt).toContain('Format requirement: Emit your plan in a marked, structured format using a top-level # Implementation Plan (or ## Plan) header');
      expect(prompt).toContain('Conversational responses without a structured plan will be rejected.');
    });

    it('evaluatePlanRubric accepts bureau-wt branch naming and structured sections', () => {
      const validPlan = `
# Implementation Plan
## Branch
bureau-wt-task-f6

## Scope & Components
Modifying engine/flow/work_review_cycle.ts and runner/main.ts

## Tests & Mutation Evidence
Adding unit tests in test/unit/tc_tail_fixes.test.ts with mutation evidence.

## Walkthrough / Verification Plan
Run vitest suite twice and verify zero operator repair.
`;
      const result = evaluatePlanRubric(validPlan);
      expect(result.ok).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('evaluatePlanRubric rejects purely conversational responses', () => {
      const conversational = "Sure, I'd love to help! Let me know what you want to work on next.";
      const result = evaluatePlanRubric(conversational);
      expect(result.ok).toBe(false);
      expect(result.missing.length).toBeGreaterThanOrEqual(3);
    });
  });
});
