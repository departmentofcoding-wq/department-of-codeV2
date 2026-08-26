import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VERIFY_STAGES, type VerifyStage } from '../../engine/contract/constants.ts';
import type { VerifyStageResult } from '../../engine/contract/types.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';

/**
 * Milestone D0 — Staged Verification Contract Freeze (A3).
 *
 * Freezes the surface the staged-verify implementation stream will build on:
 * the ordered VERIFY_STAGES vocabulary, the VerifyStageResult shape, and the new
 * nullable columns (bureau_verify_runs.stages/pass_before/pass_after,
 * bureau_tasks.acceptance_tests). No behavior — just the frozen contract.
 */
describe('Milestone D0 — Staged Verification Contract Freeze', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function freshDb() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-d0v-'));
    return openDbConnection(path.join(tempDir, 'test.db'));
  }

  function columns(db: ReturnType<typeof freshDb>, table: string): string[] {
    return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
  }

  it('1. Stage vocabulary: exactly the three ordered stages (mutation deferred)', () => {
    expect(VERIFY_STAGES).toEqual(['structural', 'fail-to-pass', 'pass-to-pass']);
    // Ordered pipeline: structural → targeted → regression.
    expect(VERIFY_STAGES[0]).toBe('structural');
    expect(VERIFY_STAGES[VERIFY_STAGES.length - 1]).toBe('pass-to-pass');
    const s: VerifyStage = 'fail-to-pass';
    expect(VERIFY_STAGES).toContain(s);
  });

  it('2. VerifyStageResult shape compiles with the frozen fields', () => {
    const result: VerifyStageResult = { stage: 'structural', exit_code: 0, duration_ms: 12, skipped: false, detail: null };
    expect(result.stage).toBe('structural');
    expect(result.exit_code).toBe(0);
  });

  it('3. Schema: bureau_verify_runs carries stages/pass_before/pass_after', () => {
    const db = freshDb();
    const cols = columns(db, 'bureau_verify_runs');
    expect(cols).toContain('stages');
    expect(cols).toContain('pass_before');
    expect(cols).toContain('pass_after');
  });

  it('4. Schema: bureau_tasks carries acceptance_tests', () => {
    const db = freshDb();
    expect(columns(db, 'bureau_tasks')).toContain('acceptance_tests');
  });

  it('5. New columns are additive/nullable — a legacy-shaped insert still works and reads null', () => {
    const db = freshDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('d0v-task', 'D0 verify', 'claimed', 'wuuid', ?, ?)`,
      now, now
    );
    // No stages/pass_* supplied — they must default null.
    db.run(
      `INSERT INTO bureau_verify_runs (id, task_id, exit_code, timed_out, duration_ms, verify_fixes_before, started_at, finished_at, actor_role, provider, model, account)
       VALUES ('d0v-run', 'd0v-task', 0, 0, 5, 0, ?, ?, 'verifier', 'deterministic', 'core', NULL)`,
      now, now
    );
    const run = db.get<{ stages: string | null; pass_before: number | null; pass_after: number | null }>(
      'SELECT stages, pass_before, pass_after FROM bureau_verify_runs WHERE id = ?', 'd0v-run'
    );
    expect(run?.stages).toBeNull();
    expect(run?.pass_before).toBeNull();
    expect(run?.pass_after).toBeNull();

    const task = db.get<{ acceptance_tests: string | null }>('SELECT acceptance_tests FROM bureau_tasks WHERE id = ?', 'd0v-task');
    expect(task?.acceptance_tests).toBeNull();

    // And the columns accept the staged-run payload shape round-tripping.
    const stages = JSON.stringify([{ stage: 'structural', exit_code: 0, duration_ms: 3 }]);
    db.run('UPDATE bureau_verify_runs SET stages = ?, pass_before = ?, pass_after = ? WHERE id = ?', stages, 100, 101, 'd0v-run');
    const updated = db.get<{ stages: string; pass_before: number; pass_after: number }>(
      'SELECT stages, pass_before, pass_after FROM bureau_verify_runs WHERE id = ?', 'd0v-run'
    );
    expect(JSON.parse(updated!.stages)[0].stage).toBe('structural');
    expect(updated!.pass_after - updated!.pass_before).toBe(1);
  });

  it('6. Boot door is idempotent — reopening the same DB keeps the columns and does not error', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-d0v-'));
    const dbPath = path.join(tempDir, 'test.db');
    openDbConnection(dbPath);
    closeDatabase();
    // Second boot re-runs applyBootMigrations (applyAddedColumns skips existing
    // columns via table_info) — no duplicate-column error.
    const db2 = openDbConnection(dbPath);
    expect(columns(db2, 'bureau_verify_runs')).toEqual(expect.arrayContaining(['stages', 'pass_before', 'pass_after']));
    expect(columns(db2, 'bureau_tasks')).toContain('acceptance_tests');
  });
});
