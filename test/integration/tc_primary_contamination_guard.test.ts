import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { handleJuniorDispatch } from '../../engine/harness/dispatch-job.ts';
import { setAntigravityDriverOverride, type AntigravityDriver } from '../../engine/harness/antigravity-seam.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../../engine/worktrees/manager.ts';
import {
  assertPrimaryTreeClean,
  changedAgainstBaseline,
  inspectPrimaryTree,
  PrimaryTreeContaminatedError,
  resolvePrimaryRepoRoot,
  snapshotPrimaryTree
} from '../../engine/worktrees/primary_guard.ts';

/**
 * N16 — the primary-checkout contamination guard.
 *
 * Scar (2026-09-01, task 0e921cfa/N11): a junior implementation dispatch wrote
 * ~284 lines of uncommitted edits into TRACKED files of the primary checkout
 * alongside its worktree work. The dispatch window is pointed at the worktree,
 * but nothing verified the primary tree stayed clean. These tests reproduce the
 * leak class (an agent that edits a tracked file in the primary repo during a
 * worktree-scoped dispatch) and prove the guard fails loud — and that honest
 * worktree-only dispatches are untouched.
 */
describe('N16: primary-checkout contamination guard', () => {
  let tmpDir: string;
  let repoPath: string;
  let db: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-n16-'));
    repoPath = path.join(tmpDir, 'repo');

    fs.mkdirSync(repoPath, { recursive: true });
    git(['init'], repoPath);
    git(['config', 'user.name', 'Test User'], repoPath);
    git(['config', 'user.email', 'test@example.com'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Primary Repo\n');
    fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 1;\n');
    git(['add', '.'], repoPath);
    git(['commit', '-m', 'initial'], repoPath);
    git(['branch', '-M', 'main'], repoPath);
  });

  afterEach(() => {
    setAntigravityDriverOverride(null);
    setWorkspaceProvider(null);
    closeDatabase();
    try { db?.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  async function seedDispatch(dbPath: string, taskId: string, dispatchId: string, jobId: string) {
    db = openDbConnection(dbPath);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at, assigned_junior, assigned_senior, assigned_at)
       VALUES (?, 'N16 Task', 'wuuid-n16', ?, ?, 'A', 'claude', ?)`,
      taskId, now, now, now
    );
    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
       VALUES (?, ?, 'wuuid-n16', 'junior-engineer', 'antigravity', 'gemini-3.7-flash', 'pending', 0, ?)`,
      dispatchId, taskId, now
    );
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, state, created_at)
       VALUES (?, 'junior.dispatch', ?, 'running', ?)`,
      jobId, taskId, now
    );
    return db;
  }

  // --- the guard helpers, against a real repo ---

  it('inspectPrimaryTree: a clean tree is clean; untracked files are NOT the leak class', () => {
    fs.writeFileSync(path.join(repoPath, 'docs-plan-untracked.md'), 'operator scratch\n');
    const inspection = inspectPrimaryTree(repoPath);
    expect(inspection.clean).toBe(true);
    expect(inspection.dirtyPaths).toEqual([]);
  });

  it('inspectPrimaryTree + assertPrimaryTreeClean: a modified TRACKED file is contamination and fails loud', () => {
    fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 2; // junior edit\n');
    const inspection = inspectPrimaryTree(repoPath);
    expect(inspection.clean).toBe(false);
    expect(inspection.dirtyPaths).toContain('engine.ts');

    expect(() => assertPrimaryTreeClean(repoPath)).toThrow(PrimaryTreeContaminatedError);
    expect(() => assertPrimaryTreeClean(repoPath)).toThrow(/engine\.ts/);
  });

  it('resolvePrimaryRepoRoot derives the owning repo from a worktree path', () => {
    const worktree = path.join(repoPath, '.bureau-worktrees', 'some-task-id');
    expect(resolvePrimaryRepoRoot(worktree)).toBe(path.resolve(repoPath));
  });

  // --- the dispatch integration: the leak class itself ---

  it('a dispatch whose agent edits a TRACKED file in the primary repo FAILS LOUD (guardrail + no completion + no chained work.cycle)', async () => {
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    // The agent "resolves the file against its other open workspace": during the
    // dispatch it edits a tracked file in the PRIMARY tree — the 0e921cfa leak.
    let seenFolder = '';
    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        seenFolder = opts?.folder ?? '';
        fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 42; // LEAKED junior edit\n');
        return { transcript: 'agent: done (but leaked)', launched: false };
      }
    } as AntigravityDriver);

    await seedDispatch(path.join(tmpDir, 'test-leak.db'), 'task-n16-leak', 'disp-n16-leak', 'job-n16-leak');

    await expect(
      handleJuniorDispatch({
        db,
        job: { id: 'job-n16-leak', task_id: 'task-n16-leak' },
        payload: { dispatchId: 'disp-n16-leak', prompt: 'implement the fix', chainWorkReview: true },
        signal: new AbortController().signal
      } as any)
    ).rejects.toThrow(PrimaryTreeContaminatedError);

    // The dispatch was worktree-scoped (the guard only ran because it was).
    expect(seenFolder).toContain(path.join('.bureau-worktrees', 'task-n16-leak'));

    // FAIL LOUD, DB-proven: dispatch NOT completed, no work.cycle chained.
    const disp = db.get(`SELECT status FROM bureau_dispatches WHERE id = 'disp-n16-leak'`);
    expect(disp.status).not.toBe('completed');
    const chained = db.get(`SELECT * FROM bureau_jobs WHERE kind = 'work.cycle' AND task_id = 'task-n16-leak'`);
    expect(chained).toBeFalsy();

    // The contamination is journaled as a guardrail with the dirty paths.
    const span = db.get(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-n16-leak'`
    );
    expect(span).toBeTruthy();
    const detail = JSON.parse(span.detail as string);
    expect(detail.action).toBe('primary_checkout_contaminated');
    expect(detail.dirtyPaths).toContain('engine.ts');

    // The leaked edit itself is untouched (left for the operator to inspect).
    expect(fs.readFileSync(path.join(repoPath, 'engine.ts'), 'utf-8')).toContain('LEAKED');
  });

  it('an honest worktree-only dispatch completes and journals primary_tree_verified_clean', async () => {
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        // The agent works ONLY inside its worktree (edits + commits there).
        const wt = opts?.folder ?? '';
        fs.writeFileSync(path.join(wt, 'feature.txt'), 'junior work\n');
        git(['add', '-A'], wt);
        git(['commit', '-m', 'junior: implement'], wt);
        return { transcript: 'agent: implemented in worktree', launched: false };
      }
    } as AntigravityDriver);

    await seedDispatch(path.join(tmpDir, 'test-clean.db'), 'task-n16-clean', 'disp-n16-clean', 'job-n16-clean');

    await handleJuniorDispatch({
      db,
      job: { id: 'job-n16-clean', task_id: 'task-n16-clean' },
      payload: { dispatchId: 'disp-n16-clean', prompt: 'implement the fix', chainWorkReview: true },
      signal: new AbortController().signal
    } as any);

    const disp = db.get(`SELECT status FROM bureau_dispatches WHERE id = 'disp-n16-clean'`);
    expect(disp.status).toBe('completed');
    const chained = db.get(`SELECT * FROM bureau_jobs WHERE kind = 'work.cycle' AND task_id = 'task-n16-clean'`);
    expect(chained).toBeTruthy();

    const span = db.get(
      `SELECT * FROM bureau_journal WHERE task_id = 'task-n16-clean' AND detail LIKE '%primary_tree_verified_clean%'`
    );
    expect(span).toBeTruthy();

    // The primary tree is genuinely clean — the junior's commit lives on the
    // bureau-wt branch in the worktree, nothing uncommitted in the primary.
    expect(inspectPrimaryTree(repoPath).clean).toBe(true);
    const worktrees = git(['worktree', 'list'], repoPath);
    expect(worktrees).toContain('task-n16-clean');
  });

  // --- F1: the guard baselines the PRE-DISPATCH dirty set (the N9 scar) ------
  //
  // 2026-09-02, task 693ad95a (N9 rekick): the operator's own uncommitted ledger
  // edit (docs/DEPARTMENT_STATUS.md) sat tracked-dirty in the primary tree when
  // the dispatch started; the absolute check blamed the junior for it and failed
  // an honest run — and would keep failing EVERY worktree dispatch until the
  // operator committed. The guard now snapshots the dirty set (with per-path
  // content oids) at dispatch start and flags only what the run ITSELF dirtied.

  it('snapshotPrimaryTree: clean tree → empty; modified → per-path oid; deleted → null', () => {
    const clean = snapshotPrimaryTree(repoPath);
    expect(clean.dirty).toEqual({});

    fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 2;\n');
    const snap = snapshotPrimaryTree(repoPath);
    expect(Object.keys(snap.dirty)).toEqual(['engine.ts']);
    expect(snap.dirty['engine.ts']).toBe(git(['hash-object', 'engine.ts'], repoPath));

    fs.rmSync(path.join(repoPath, 'README.md'));
    const snap2 = snapshotPrimaryTree(repoPath);
    expect(snap2.dirty['README.md']).toBeNull();
    expect(snap2.dirty['engine.ts']).toBe(snap.dirty['engine.ts']);
  });

  it('changedAgainstBaseline (pure): pre-existing dirt ignored; new dirt and content changes flagged', () => {
    const mk = (repoRoot: string, dirty: Record<string, string | null>) => ({ repoRoot, dirty, capturedAt: 't' });
    const before = mk('D:/repo', { 'docs/LEDGER.md': 'a'.repeat(40), 'engine.ts': 'b'.repeat(40) });
    // Same two dirty paths, same oids, one path reverted clean: nothing changed.
    expect(changedAgainstBaseline(before, mk('D:/repo', { 'docs/LEDGER.md': 'a'.repeat(40) }))).toEqual([]);
    // A pre-existing dirty file whose content the run FURTHER changed → flagged.
    expect(
      changedAgainstBaseline(before, mk('D:/repo', { 'docs/LEDGER.md': 'a'.repeat(40), 'engine.ts': 'c'.repeat(40) }))
    ).toEqual(['engine.ts']);
    // A path newly dirtied by the run → flagged; the untouched ledger edit is not.
    expect(
      changedAgainstBaseline(before, mk('D:/repo', { 'docs/LEDGER.md': 'a'.repeat(40), 'engine.ts': 'b'.repeat(40), 'src/new.ts': 'd'.repeat(40) }))
    ).toEqual(['src/new.ts']);
    // Deletion during the run (oid → null) is a change; pre-existing deletion that
    // stays deleted is not.
    expect(
      changedAgainstBaseline(mk('D:/repo', { 'README.md': null }), mk('D:/repo', { 'README.md': null }))
    ).toEqual([]);
    expect(changedAgainstBaseline(mk('D:/repo', {}), mk('D:/repo', { 'README.md': null }))).toEqual(['README.md']);
    // Mismatched roots compare conservatively (all after-dirt flagged).
    expect(changedAgainstBaseline(mk('D:/other', {}), mk('D:/repo', { 'a.ts': 'e'.repeat(40) }))).toEqual(['a.ts']);
    // Rename entries are keyed as the composite "old -> new" string and never
    // resolve to a file (oid null, same bucket as deletions): a pre-existing
    // untouched rename is not flagged, and a rename that appears DURING the run
    // is new dirt. (Senior review follow-up: this case was verified manually
    // against `git mv` but had no explicit unit pin.)
    const renameKey = 'docs/old.md -> docs/new.md';
    expect(changedAgainstBaseline(mk('D:/repo', { [renameKey]: null }), mk('D:/repo', { [renameKey]: null }))).toEqual([]);
    expect(changedAgainstBaseline(mk('D:/repo', {}), mk('D:/repo', { [renameKey]: null }))).toEqual([renameKey]);
  });

  it('F1 (the N9 false-positive): a PRE-EXISTING uncommitted operator edit does NOT fail an honest worktree-only dispatch', async () => {
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    // The operator's ledger edit: tracked, committed once, then modified and left
    // uncommitted BEFORE the dispatch starts — the exact N9 shape.
    fs.mkdirSync(path.join(repoPath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'docs', 'DEPARTMENT_STATUS.md'), 'v1\n');
    git(['add', 'docs/DEPARTMENT_STATUS.md'], repoPath);
    git(['commit', '-m', 'add ledger'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'docs', 'DEPARTMENT_STATUS.md'), 'v2 — operator mid-edit\n');
    expect(inspectPrimaryTree(repoPath).clean).toBe(false);

    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        const wt = opts?.folder ?? '';
        fs.writeFileSync(path.join(wt, 'feature.txt'), 'junior work\n');
        git(['add', '-A'], wt);
        git(['commit', '-m', 'junior: implement'], wt);
        return { transcript: 'agent: implemented in worktree', launched: false };
      }
    } as AntigravityDriver);

    await seedDispatch(path.join(tmpDir, 'test-n9.db'), 'task-n9-rekick', 'disp-n9-rekick', 'job-n9-rekick');

    await handleJuniorDispatch({
      db,
      job: { id: 'job-n9-rekick', task_id: 'task-n9-rekick' },
      payload: { dispatchId: 'disp-n9-rekick', prompt: 'implement the fix', chainWorkReview: true },
      signal: new AbortController().signal
    } as any);

    // The innocent dispatch COMPLETES (pre-F1 it was failed by the absolute check).
    const disp = db.get(`SELECT status FROM bureau_dispatches WHERE id = 'disp-n9-rekick'`);
    expect(disp.status).toBe('completed');

    // The baseline was journaled with the pre-existing dirt on the record...
    const baselineSpan = db.get(
      `SELECT * FROM bureau_journal WHERE task_id = 'task-n9-rekick' AND detail LIKE '%primary_tree_baseline_captured%'`
    );
    expect(baselineSpan).toBeTruthy();
    expect(JSON.parse(baselineSpan.detail as string).preexistingDirtyPaths).toContain(
      'docs/DEPARTMENT_STATUS.md'
    );
    // ...and the verification says clean AGAINST THE BASELINE.
    const span = db.get(
      `SELECT * FROM bureau_journal WHERE task_id = 'task-n9-rekick' AND detail LIKE '%primary_tree_verified_clean%'`
    );
    expect(JSON.parse(span.detail as string).againstBaseline).toBe(true);

    // The operator's edit is untouched and still uncommitted — not the junior's.
    expect(fs.readFileSync(path.join(repoPath, 'docs', 'DEPARTMENT_STATUS.md'), 'utf-8')).toContain('operator mid-edit');
  });

  it('F1: a NEW tracked-primary leak still fails loud even with pre-existing dirt — and only the leak is blamed', async () => {
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    fs.mkdirSync(path.join(repoPath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'docs', 'DEPARTMENT_STATUS.md'), 'v1\n');
    git(['add', 'docs/DEPARTMENT_STATUS.md'], repoPath);
    git(['commit', '-m', 'add ledger'], repoPath);
    fs.writeFileSync(path.join(repoPath, 'docs', 'DEPARTMENT_STATUS.md'), 'v2 — operator mid-edit\n');

    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        const wt = opts?.folder ?? '';
        fs.writeFileSync(path.join(wt, 'feature.txt'), 'junior work\n');
        git(['add', '-A'], wt);
        git(['commit', '-m', 'junior: implement'], wt);
        // ...and ALSO leaks a tracked file into the primary (the 0e921cfa class).
        fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 42; // LEAKED junior edit\n');
        return { transcript: 'agent: done (but leaked)', launched: false };
      }
    } as AntigravityDriver);

    await seedDispatch(path.join(tmpDir, 'test-n9-leak.db'), 'task-n9-leak', 'disp-n9-leak', 'job-n9-leak');

    await expect(
      handleJuniorDispatch({
        db,
        job: { id: 'job-n9-leak', task_id: 'task-n9-leak' },
        payload: { dispatchId: 'disp-n9-leak', prompt: 'implement the fix', chainWorkReview: true },
        signal: new AbortController().signal
      } as any)
    ).rejects.toThrow(PrimaryTreeContaminatedError);

    // Only the JUNIOR's leak is blamed — the operator's pre-existing edit is not.
    const span = db.get(
      `SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-n9-leak'`
    );
    const detail = JSON.parse(span.detail as string);
    expect(detail.dirtyPaths).toEqual(['engine.ts']);
    expect(detail.dirtyPaths).not.toContain('docs/DEPARTMENT_STATUS.md');
    expect(detail.preexistingDirtyPaths).toContain('docs/DEPARTMENT_STATUS.md');
  });

  it('F1: a pre-existing dirty file the dispatch FURTHER changes IS flagged (content oid moved)', async () => {
    const provider = new GitWorkspaceProvider(repoPath);
    setWorkspaceProvider(provider);

    // engine.ts already dirty before the dispatch (operator edit)...
    fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 2; // operator edit\n');
    // ...and the junior appends to the SAME file during the run.
    setAntigravityDriverOverride({
      async runCommand(_prompt, opts) {
        const wt = opts?.folder ?? '';
        fs.writeFileSync(path.join(wt, 'feature.txt'), 'junior work\n');
        git(['add', '-A'], wt);
        git(['commit', '-m', 'junior: implement'], wt);
        fs.writeFileSync(path.join(repoPath, 'engine.ts'), 'export const x = 2; // operator edit\n// LEAKED junior append\n');
        return { transcript: 'agent: done (but leaked)', launched: false };
      }
    } as AntigravityDriver);

    await seedDispatch(path.join(tmpDir, 'test-n9-c.db'), 'task-n9-c', 'disp-n9-c', 'job-n9-c');

    await expect(
      handleJuniorDispatch({
        db,
        job: { id: 'job-n9-c', task_id: 'task-n9-c' },
        payload: { dispatchId: 'disp-n9-c', prompt: 'implement the fix', chainWorkReview: true },
        signal: new AbortController().signal
      } as any)
    ).rejects.toThrow(PrimaryTreeContaminatedError);

    const span = db.get(`SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-n9-c'`);
    expect(JSON.parse(span.detail as string).dirtyPaths).toEqual(['engine.ts']);
  });
});
