import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AttributionTuple, BureauJobRow, DbConnection } from '../../engine/contract/types.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { setPrProviderOverride } from '../../engine/contract/pr-seam.ts';
import { setBackupProviderOverride, type BackupProvider } from '../../engine/contract/backup-seam.ts';
import { setSeniorDriverOverride } from '../../engine/harness/senior-seam.ts';
import { setAntigravityDriverOverride } from '../../engine/harness/antigravity-seam.ts';
import { createSession, updateSessionDraft } from '../../engine/intake/session.ts';
import { confirmVerify } from '../../engine/intake/confirm.ts';
import { fileTask } from '../../engine/filing/file_task.ts';
import { reconcileQueuedTasks } from '../../engine/flow/reconcile.ts';
import { approveTask } from '../../engine/state/machine.ts';
import { archiveTask } from '../../engine/state/archive.ts';
import { journal, MAX_JOURNAL_STRING_CHARS } from '../../engine/journal/writer.ts';
import { narrateEntry } from '../../engine/journal/narrate.ts';
import { drainSingleJob } from '../../runner/main.ts';

describe('tc_journal_completeness: full flow reconstructable from journal alone', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    setSeniorDriverOverride(null);
    setAntigravityDriverOverride(null);
    setPrProviderOverride(null);
    setBackupProviderOverride(null);
    setWorkspaceProvider(null);
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  async function drainAllJobs(db: DbConnection, maxSteps = 40): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      const next = db.get<BureauJobRow>(
        `SELECT * FROM bureau_jobs WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?)
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        new Date().toISOString()
      );
      if (!next) break;
      await drainSingleJob(db, next.id);
    }
  }

  it('records full pipeline story from intake to delivery in the journal with zero secrets and safe truncation', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-jcomplete-'));
    const repoPath = path.join(tempDir, 'repo');
    const dbPath = path.join(tempDir, 'test.db');

    // 1. Initialize real git repo
    fs.mkdirSync(repoPath, { recursive: true });
    git(['init'], repoPath);
    git(['config', 'user.name', 'Bureau Tester'], repoPath);
    git(['config', 'user.email', 'tester@bureau.local'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Complete Flow Repo\n');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'initial commit'], repoPath);
    git(['branch', '-M', 'main'], repoPath);

    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);
    const pr = new FakePrProvider();
    setPrProviderOverride(pr);

    const fakeBackup: BackupProvider = {
      async push() {},
      async getRemoteTip() { return 'fake-remote-tip-hash'; },
      async getLocalTip() { return 'fake-local-tip-hash'; },
      async fetch() {},
      async remoteContains() { return true; },
      async fastForwardLocal() {}
    };
    setBackupProviderOverride(fakeBackup);

    // Mock secrets to inject into junior/senior prompts and responses
    const SECRET_KEY_1 = 'sk-ant-api03-12345678901234567890123456789012345678';
    const SECRET_KEY_2 = 'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456';
    const SECRET_KEY_3 = 'bureau-secret-classified-12345';
    const SECRET_ENV_ASSIGN = 'GOOGLE_API_KEY=supersecretkey999';

    let planRoundCount = 0;
    setAntigravityDriverOverride({
      async runCommand(prompt: string, opts: any) {
        if (prompt.includes('Here is a task for you to plan')) {
          planRoundCount++;
          if (planRoundCount === 1) {
            return {
              launched: true,
              junior: 'A',
              model: 'gemini-2.5-flash',
              transcript: `Implementation Plan (Draft 1)\n1. Scope: Add feature\n2. Tests: unit tests\n[Secret: ${SECRET_KEY_1}]`,
              plan: `# Implementation Plan\n## Branch: bureau-wt-task\n## Scope\nEdit index.ts\n## Tests and Mutation Evidence\nAdd test/feature.test.ts with mutation tests\n## Walkthrough Plan\nVerify with exit 0.\n${SECRET_ENV_ASSIGN}`
            };
          }
          return {
            launched: true,
            junior: 'A',
            model: 'gemini-2.5-flash',
            transcript: `Implementation Plan (Revised)\n1. Scope: index.ts\n2. Tests: test/feature.test.ts\n3. Walkthrough`,
            plan: `# Implementation Plan\n## Branch: bureau-wt-task\n## Scope\nEdit index.ts\n## Tests and Mutation Evidence\nAdd test/feature.test.ts with mutation tests\n## Walkthrough Plan\nRun test suite and verify clean exit.\n[Secret: ${SECRET_KEY_2}]`
          };
        }
        // Junior implementation dispatch
        return {
          launched: true,
          junior: 'A',
          model: 'gemini-2.5-flash',
          transcript: `Completed implementation.\nWalkthrough:\nAdded index.ts and test/feature.test.ts.\nBUREAU-JUNIOR-COMPLETE`,
          walkthrough: `## Walkthrough\nImplemented the feature cleanly and added all tests.\n${SECRET_KEY_3}`
        };
      }
    } as any);

    let reviewRoundCount = 0;
    setSeniorDriverOverride({
      async review(input: any) {
        if (input.kind === 'plan') {
          reviewRoundCount++;
          if (reviewRoundCount === 1) {
            return {
              senior: 'claude',
              verdict: 'revise',
              feedback: 'Please include explicit mutation evidence test cases and branch discipline.',
              raw: 'VERDICT: REVISE',
              model: 'claude-3-7-sonnet'
            };
          }
          return {
            senior: 'claude',
            verdict: 'approve',
            feedback: 'Plan is comprehensive and approved.',
            raw: 'VERDICT: APPROVE',
            model: 'claude-3-7-sonnet'
          };
        }
        if (input.kind === 'diff') {
          return {
            senior: 'zai',
            verdict: 'approve',
            feedback: 'Code diff is minimal and well-tested.',
            raw: 'VERDICT: APPROVE',
            model: 'glm-4-plus'
          };
        }
        // Walkthrough review
        return {
          senior: 'claude',
          verdict: 'approve',
          feedback: 'Walkthrough verified: all tests pass and implementation is complete.',
          raw: 'VERDICT: APPROVE',
          model: 'claude-3-7-sonnet'
        };
      }
    } as any);

    const db = openDbConnection(dbPath);

    const officerAttribution: AttributionTuple = {
      actor_role: 'intake-officer',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      account: null
    };

    // 2. Intake session & Filing
    const session = createSession(db, {
      idempotencyKey: 'intake-completeness-1',
      title: 'Complete Journal Task',
      attribution: officerAttribution
    });
    updateSessionDraft(db, session.id, {
      title: 'Complete Journal Task',
      intent: 'Prove complete flow reconstructability from journal alone',
      spec: 'Audit and record all prompts, senior feedbacks, verifier details, and delivery events',
      acceptance: 'Journal captures entire pipeline journey with zero secrets',
      verify_cmd: 'node --version'
    });

    confirmVerify(db, session.id, {
      actor_role: 'human-operator',
      provider: 'human',
      model: 'operator',
      account: null
    });

    const task = fileTask(db, session.id, officerAttribution);
    expect(task).toBeDefined();
    expect(task.state).toBe('queued');

    // 3. Queue admission & Assignment
    const reconciled = reconcileQueuedTasks(db);
    expect(reconciled.length).toBe(1);

    // 4. Drain Plan Cycle (Round 1: Revise, Round 2: Approve -> Dispatches junior.dispatch)
    await drainAllJobs(db);

    // 5. Drain Implementation (junior.dispatch -> chains work.cycle -> chains worktree.prepare & verify.run -> lands in needs-review)
    await drainAllJobs(db);

    const midTask = db.get<{ state: string }>('SELECT state FROM bureau_tasks WHERE id = ?', task.id);
    expect(midTask?.state).toBe('needs-review');

    // 6. Operator approves task -> enqueues work.diff-review
    approveTask(db, task.id, { actor_role: 'human-operator', provider: 'human', model: 'operator', account: null });

    // 7. Drain diff-review -> pr.create -> pr.merge -> backup.push -> done
    await drainAllJobs(db);

    const doneTask = db.get<{ state: string; pull_request_url: string; merged_by: string }>(
      'SELECT state, pull_request_url, merged_by FROM bureau_tasks WHERE id = ?',
      task.id
    );
    expect(doneTask?.state).toBe('done');
    expect(doneTask?.pull_request_url).toBeTruthy();
    expect(doneTask?.merged_by).toBeTruthy();

    // 8. Operator archives task
    archiveTask(db, task.id, { actor_role: 'human-operator', provider: 'human', model: 'operator', account: null });

    // 9. Inspect Journal Spans for Complete Reconstruction
    const journalRows = db.all<{
      id: number;
      ts: string;
      kind: string;
      actor_role: string;
      provider: string;
      model: string;
      task_id: string;
      job_id: string | null;
      detail: string;
    }>('SELECT * FROM bureau_journal WHERE task_id = ? ORDER BY id ASC', task.id);

    expect(journalRows.length).toBeGreaterThan(10);

    // Assertion A: task-filed span carries title, intent, spec, acceptance, verify_cmd
    const filedSpan = journalRows.find(r => r.kind === 'task-filed');
    expect(filedSpan).toBeDefined();
    const filedDetail = JSON.parse(filedSpan!.detail);
    expect(filedDetail.title).toBe('Complete Journal Task');
    expect(filedDetail.intent).toBe('Prove complete flow reconstructability from journal alone');
    expect(filedDetail.verify_cmd).toBe('node --version');

    // Assertion B: assignment span records junior and senior
    const assignmentSpan = journalRows.find(r => r.kind === 'assignment');
    expect(assignmentSpan).toBeDefined();
    const assignmentDetail = JSON.parse(assignmentSpan!.detail);
    expect(assignmentDetail.junior).toBeTruthy();
    expect(assignmentDetail.senior).toBeTruthy();

    // Assertion C: Plan authoring observation spans contain verbatim prompt delivered
    const planAuthoringSpans = journalRows.filter(r => r.kind === 'observation' && r.detail.includes('plan-authoring'));
    expect(planAuthoringSpans.length).toBe(2); // Round 1 and Round 2
    for (const span of planAuthoringSpans) {
      const d = JSON.parse(span.detail);
      expect(d.prompt).toContain('Here is a task for you to plan');
      expect(d.prompt).toContain('Complete Journal Task');
      expect(d.model).toBeTruthy();
    }

    // Assertion D: Review rounds carry senior's full feedback
    const planReviewSpans = journalRows.filter(r => r.kind === 'review' && r.detail.includes('plan-review'));
    expect(planReviewSpans.length).toBe(2);
    const round1Review = JSON.parse(planReviewSpans[0].detail);
    expect(round1Review.verdict).toBe('amend');
    expect(round1Review.feedback).toContain('Please include explicit mutation evidence');
    const round2Review = JSON.parse(planReviewSpans[1].detail);
    expect(round2Review.verdict).toBe('approved');
    expect(round2Review.feedback).toContain('Plan is comprehensive and approved');

    // Assertion E: Junior implementation dispatch carries verbatim implementation prompt
    const implObservation = journalRows.find(r => r.kind === 'observation' && !r.detail.includes('plan-authoring'));
    expect(implObservation).toBeDefined();
    const implDetail = JSON.parse(implObservation!.detail);
    expect(implDetail.prompt).toContain('Your implementation plan was reviewed and APPROVED by a senior');
    expect(implDetail.conversationMode).toBe('continue');

    // Assertion F: Walkthrough review carries senior feedback
    const workReviewSpan = journalRows.find(r => r.kind === 'review' && r.detail.includes('work-review'));
    expect(workReviewSpan).toBeDefined();
    const workReviewDetail = JSON.parse(workReviewSpan!.detail);
    expect(workReviewDetail.verdict).toBe('approved');
    expect(workReviewDetail.feedback).toContain('Walkthrough verified');

    // Assertion G: Verify run tool span carries verify command, stage breakdown, pass counts, and stdout/stderr tail
    const verifySpan = journalRows.find(r => r.kind === 'tool' && r.detail.includes('verify_run_completed'));
    expect(verifySpan).toBeDefined();
    const verifyDetail = JSON.parse(verifySpan!.detail);
    expect(verifyDetail.verify_cmd).toBe('node --version');
    expect(verifyDetail.exit_code).toBe(0);
    expect(Array.isArray(verifyDetail.stages)).toBe(true);
    expect(verifyDetail.stdout_tail).toBeDefined();

    // Assertion H: Diff review carries full feedback and reviewed commit
    const diffReviewSpan = journalRows.find(r => r.kind === 'review' && r.detail.includes('diff-review'));
    expect(diffReviewSpan).toBeDefined();
    const diffReviewDetail = JSON.parse(diffReviewSpan!.detail);
    expect(diffReviewDetail.verdict).toBe('approved');
    expect(diffReviewDetail.feedback).toContain('Code diff is minimal and well-tested');

    // Assertion I: PR create, PR merge, Backup push, and Operator Archive spans
    const prCreateSpan = journalRows.find(r => r.kind === 'system' && r.detail.includes('"action":"pr.create"'));
    expect(prCreateSpan).toBeDefined();
    const prMergeSpan = journalRows.find(r => r.kind === 'system' && r.detail.includes('"action":"pr.merge"'));
    expect(prMergeSpan).toBeDefined();
    const backupSpan = journalRows.find(r => r.kind === 'system' && r.detail.includes('"action":"backup.push"'));
    expect(backupSpan).toBeDefined();
    const archiveSpan = journalRows.find(r => r.kind === 'human' && r.detail.includes('archive'));
    expect(archiveSpan).toBeDefined();

    // Assertion J: Secret hygiene — zero raw secret material in any journal row
    for (const row of journalRows) {
      expect(row.detail).not.toContain(SECRET_KEY_1);
      expect(row.detail).not.toContain(SECRET_KEY_2);
      expect(row.detail).not.toContain(SECRET_KEY_3);
      expect(row.detail).not.toContain('supersecretkey999');
    }

    // Assertion K: Payload truncation bounds
    const oversizedPayload = 'A'.repeat(MAX_JOURNAL_STRING_CHARS + 5000);
    const truncRow = journal(db, {
      kind: 'system',
      attribution: officerAttribution,
      taskId: task.id,
      detail: { oversized: oversizedPayload }
    });
    const parsedTrunc = JSON.parse(truncRow.detail);
    expect(parsedTrunc.oversized).toContain(`[TRUNCATED: original length ${MAX_JOURNAL_STRING_CHARS + 5000} characters]`);
    expect(parsedTrunc.oversized.length).toBeLessThan(MAX_JOURNAL_STRING_CHARS + 200);

    // Assertion L: Console timeline narration renders readable English for every span
    for (const row of journalRows) {
      const sentence = narrateEntry(row);
      expect(typeof sentence).toBe('string');
      expect(sentence.length).toBeGreaterThan(5);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });
});
