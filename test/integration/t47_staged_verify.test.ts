import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BureauTaskRow, BureauVerifyRunRow } from '../../engine/contract/index.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { runStagedVerifier, parsePassCount } from '../../engine/verify/verifier.ts';
import { executeVerifyRunJob } from '../../engine/verify/job.ts';
import { setWorkspaceProvider } from '../../engine/contract/workspace-seam.ts';
import { FakeWorkspaceProvider } from '../helpers/fake_workspace_provider.ts';

/**
 * T47 — staged verification (A3). structural → fail-to-pass → pass-to-pass,
 * short-circuiting on the first failing stage; the aggregate exit code is 0 iff
 * every non-skipped stage passed (the unchanged kernel contract). The
 * pass-to-pass stage records pass_before/pass_after.
 */
describe('T47: staged verifier', () => {
  let tempDir: string | null = null;
  let ws: FakeWorkspaceProvider | null = null;

  afterEach(() => {
    setWorkspaceProvider(null);
    ws?.cleanup();
    ws = null;
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function db() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t47-'));
    return openDbConnection(path.join(tempDir, 'test.db'));
  }

  function seedTask(conn: any, id: string, opts: { verify_cmd: string; acceptance_tests?: string | null; state?: string }) {
    const now = new Date().toISOString();
    conn.run(
      `INSERT INTO bureau_tasks (id, title, verify_cmd, acceptance_tests, state, verify_fixes, work_uuid, created_at, updated_at)
       VALUES (?, 'T47', ?, ?, ?, 0, 'wuuid-47', ?, ?)`,
      id, opts.verify_cmd, opts.acceptance_tests ?? null, opts.state ?? 'claimed', now, now
    );
  }

  const PASS = 'node --version';
  const FAIL = 'node -e "process.exit(1)"';
  const PASS_WITH_COUNT = (n: number) => `node -e "console.log('Tests ${n} passed')"`;
  const wsDir = () => { const d = path.join(tempDir!, 'work'); fs.mkdirSync(d, { recursive: true }); return d; };

  it('parsePassCount takes the last "<n> passed" number, else null', () => {
    expect(parsePassCount('Test Files 3 passed\nTests 441 passed (441)')).toBe(441);
    expect(parsePassCount('no numbers here')).toBeNull();
  });

  it('all three stages configured and passing → exit 0, three ordered stages, pass count parsed', async () => {
    const conn = db();
    conn.run(`INSERT INTO bureau_meta (key, value) VALUES ('verify:structural_cmd', ?)`, PASS);
    seedTask(conn, 't-all', { verify_cmd: PASS_WITH_COUNT(7), acceptance_tests: PASS });

    const res = await runStagedVerifier(conn, 't-all', wsDir());
    expect(res.exitCode).toBe(0);
    expect(res.stages.map((s) => s.stage)).toEqual(['structural', 'fail-to-pass', 'pass-to-pass']);
    expect(res.stages.every((s) => !s.skipped)).toBe(true);
    expect(res.passAfter).toBe(7);
  });

  it('degrades to pass-to-pass only when nothing else is configured (skipped stages, still passes)', async () => {
    const conn = db();
    seedTask(conn, 't-degrade', { verify_cmd: PASS });

    const res = await runStagedVerifier(conn, 't-degrade', wsDir());
    expect(res.exitCode).toBe(0);
    const byStage = Object.fromEntries(res.stages.map((s) => [s.stage, s]));
    expect(byStage['structural'].skipped).toBe(true);
    expect(byStage['fail-to-pass'].skipped).toBe(true);
    expect(byStage['pass-to-pass'].skipped).toBeUndefined();
    expect(byStage['pass-to-pass'].exit_code).toBe(0);
  });

  it('structural failure short-circuits — fail-to-pass and pass-to-pass never run', async () => {
    const conn = db();
    conn.run(`INSERT INTO bureau_meta (key, value) VALUES ('verify:structural_cmd', ?)`, FAIL);
    seedTask(conn, 't-struct-fail', { verify_cmd: PASS, acceptance_tests: PASS });

    const res = await runStagedVerifier(conn, 't-struct-fail', wsDir());
    expect(res.exitCode).not.toBe(0);
    // Only the structural stage ran; the rest were short-circuited away.
    expect(res.stages.map((s) => s.stage)).toEqual(['structural']);
    expect(res.stages[0].exit_code).not.toBe(0);
    expect(res.passAfter).toBeNull();
  });

  it('fail-to-pass failure short-circuits before pass-to-pass', async () => {
    const conn = db();
    conn.run(`INSERT INTO bureau_meta (key, value) VALUES ('verify:structural_cmd', ?)`, PASS);
    seedTask(conn, 't-ftp-fail', { verify_cmd: PASS, acceptance_tests: FAIL });

    const res = await runStagedVerifier(conn, 't-ftp-fail', wsDir());
    expect(res.exitCode).not.toBe(0);
    expect(res.stages.map((s) => s.stage)).toEqual(['structural', 'fail-to-pass']);
  });

  it('refuses a vacuous stage command (greenwash guard applies per stage)', async () => {
    const conn = db();
    seedTask(conn, 't-vac', { verify_cmd: PASS, acceptance_tests: 'exit 0' });
    await expect(runStagedVerifier(conn, 't-vac', wsDir())).rejects.toThrow(/vacuous/i);
  });

  it('records pass_before from the prior run and pass_after from this one', async () => {
    const conn = db();
    seedTask(conn, 't-regress', { verify_cmd: PASS_WITH_COUNT(12) });
    const now = new Date().toISOString();
    // A prior verify run for this task recorded 10 passing.
    conn.run(
      `INSERT INTO bureau_verify_runs (id, task_id, exit_code, timed_out, duration_ms, verify_fixes_before, pass_after, started_at, finished_at, actor_role, provider, model, account)
       VALUES ('prior', 't-regress', 0, 0, 5, 0, 10, ?, ?, 'verifier', 'deterministic', 'core', NULL)`,
      now, now
    );

    const res = await runStagedVerifier(conn, 't-regress', wsDir());
    expect(res.passBefore).toBe(10);
    expect(res.passAfter).toBe(12);
  });

  it('via the job: persists the stages JSON + pass counts and transitions to needs-review', async () => {
    const conn = db();
    ws = new FakeWorkspaceProvider();
    setWorkspaceProvider(ws);
    seedTask(conn, 't-job', { verify_cmd: PASS_WITH_COUNT(3), state: 'claimed' });
    // The verify span references job_id; seed the job row for the FK.
    conn.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, created_at)
       VALUES ('job-47', 'verify.run', 't-job', '{}', 'running', ?)`,
      new Date().toISOString()
    );

    await executeVerifyRunJob({
      db: conn,
      job: { id: 'job-47', task_id: 't-job', kind: 'verify.run' },
      payload: { taskId: 't-job' },
      signal: new AbortController().signal
    } as any);

    const task = conn.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', 't-job');
    expect(task?.state).toBe('needs-review');
    expect(task?.verifier_exit_code).toBe(0);

    const run = conn.get<BureauVerifyRunRow>('SELECT * FROM bureau_verify_runs WHERE task_id = ?', 't-job');
    expect(run?.exit_code).toBe(0);
    expect(run?.pass_after).toBe(3);
    const stages = JSON.parse(run!.stages!);
    expect(stages.find((s: any) => s.stage === 'pass-to-pass').exit_code).toBe(0);
  });
});
