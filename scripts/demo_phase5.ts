/**
 * Phase 5 Exit Demo — Hardening.
 *
 * Exit sentence: the department survives its own failures — stranded work is
 * detected and the operator is rung, history exists in more than one place,
 * windows hand off through the record, the journal is legible through
 * read-only dashboards, and the red team's best shots end in guardrail spans.
 *
 * Runs entirely against a temp DB with a fake backup provider; touches no
 * network and no live db/bureau.db; cleans up after itself; exits 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDbConnection } from '../engine/db/index.ts';
import { detectWatchdogFindings } from '../engine/watchdog/sweep.ts';
import { claimOwnership, releaseOwnership } from '../engine/secretary/ownership.ts';
import { handleBackupPush, BackupPushError } from '../engine/durability/backup_push.ts';
import { setBackupProviderOverride } from '../engine/contract/backup-seam.ts';
import { dashboardSnapshot } from '../engine/dashboards/views.ts';
import { scrubEnv, redactOutput } from '../engine/contract/tools.ts';
import type { BackupProvider, BureauJobRow, JobContext } from '../engine/contract/index.ts';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`DEMO ASSERTION FAILED: ${msg}`);
}

async function main(): Promise<void> {
  console.log('=== DEPARTMENT OF CODE V2 — PHASE 5 EXIT DEMO (HARDENING) ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-demo-phase5-'));
  const dbPath = path.join(tmpDir, 'demo.db');
  const db = openDbConnection(dbPath);
  const now = new Date().toISOString();

  try {
    // ---- 1. WATCHDOG: stranded work is detected (read-only) --------------
    // A task stuck in 'verifying' with a completed job and no live verify.run.
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('demo-stuck','Stranded task','verifying','w-stuck',?,?)`, now, now
    );
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, reaped_count, created_at)
       VALUES ('demo-stuck-job','verify.run','demo-stuck','{}','done',1,3,0,?)`, now
    );
    const findings = detectWatchdogFindings(db);
    assert(findings.length >= 1, 'watchdog detected the stranded task');
    console.log(`[watchdog]  detected ${findings.length} stranded finding(s); operator can be rung.`);

    // Read-only proof: a second sweep produces no duplicate active finding.
    const before = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM bureau_watchdog_findings`);
    detectWatchdogFindings(db);
    const after = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM bureau_watchdog_findings`);
    assert(before?.c === after?.c, 'sweep is idempotent (no duplicate active findings)');
    console.log('[watchdog]  re-sweep produced no duplicates (idempotent, read-only).');

    // ---- 2. SECRETARY: windows hand off through the record --------------
    claimOwnership(db, { key: 'window:1', holderId: 'junior-a', holderRole: 'junior-engineer', notes: 'A owns window 1' });
    let refused = false;
    try {
      claimOwnership(db, { key: 'window:1', holderId: 'junior-b', holderRole: 'junior-engineer' });
    } catch { refused = true; }
    assert(refused, 'second claim on a held window is fail-closed refused');
    const released = releaseOwnership(db, { key: 'window:1', holderId: 'junior-a' });
    assert(released, 'holder can release its own window');
    console.log('[secretary] claim/refuse-double-claim/release enforced through bureau_ownership.');

    // ---- 3. BACKUP: history exists in more than one place --------------
    const tip = 'a'.repeat(40);
    const goodProvider: BackupProvider = {
      async getLocalTip() { return tip; },
      async push() { /* pretend push */ },
      async getRemoteTip() { return tip; }
    };
    setBackupProviderOverride(goodProvider);
    const mkCtx = (): JobContext => ({
      db,
      job: { id: 'demo-backup', kind: 'backup.push', task_id: null } as BureauJobRow,
      payload: { target: 'origin/main' },
      signal: new AbortController().signal
    });
    await handleBackupPush(mkCtx());
    console.log('[backup]    push verified: remote tip matches local — history mirrored.');

    // Fail-closed: a mismatching remote tip is refused, not claimed as success.
    setBackupProviderOverride({ ...goodProvider, async getRemoteTip() { return 'b'.repeat(40); } });
    let backupRefused = false;
    try { await handleBackupPush(mkCtx()); } catch (e) { backupRefused = e instanceof BackupPushError; }
    assert(backupRefused, 'backup.push fails closed on a remote-tip mismatch');
    setBackupProviderOverride(null);
    console.log('[backup]    mismatch fails closed with a guardrail span (no false success).');

    // ---- 4. RED TEAM: best shots end in guardrail spans, not breaches ----
    const clean = scrubEnv({ PATH: '/usr/bin', BUREAU_SECRET: 'bureau-secret-x', GOOGLE_API_KEY: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456' });
    assert(clean.BUREAU_SECRET === undefined && clean.GOOGLE_API_KEY === undefined, 'secrets scrubbed from child env');
    const redacted = redactOutput('leak GOOGLE_API_KEY=topsecret here');
    assert(redacted.includes('[REDACTED]') && !redacted.includes('topsecret'), 'secret value redacted from output');
    console.log('[red-team]  exfiltration attempt scrubbed and redacted.');

    // ---- 5. DASHBOARD: the journal is legible ---------------------------
    const snap = dashboardSnapshot(db);
    console.log(
      `[dashboard] states=${snap.statePopulations.length} tasks=${snap.budgetSpend.length} ` +
      `guardrail-spans=${snap.guardrailCount} verify-fail-rate=${(snap.verifyFailureRate.failure_rate * 100).toFixed(0)}%`
    );
    assert(snap.guardrailCount >= 1, 'dashboard shows the guardrail spans the red team/backup produced');

    // ---- Journal hygiene: no key material leaked into any span ---------
    const allDetail = db.all<{ detail: string }>(`SELECT detail FROM bureau_journal`).map(r => r.detail).join('\n');
    assert(!allDetail.includes('topsecret') && !allDetail.includes('bureau-secret-x'), 'no secret material in the journal');
    console.log('\n=== PHASE 5 EXIT SENTENCE DEMONSTRATED — clean exit 0 ===');
  } finally {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
