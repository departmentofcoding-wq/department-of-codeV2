import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DbConnection,
  IdeDriver,
  IdeDriverAction,
  IdeDriverActResult,
  IdeDriverReadResult,
  IdeDriverSnapshotResult
} from '../../engine/contract/index.ts';
import { scrubEnv, redactOutput } from '../../engine/contract/tools.ts';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { GatedIdeDriver, UncalibratedSelectorError } from '../../engine/selectors/gate.ts';
import { runVerifier } from '../../engine/verify/verifier.ts';

/**
 * T50 — Standing red-team suite (Milestone B3). Each of the department's four
 * standing attack surfaces gets an adversarial probe. Every attack must end in
 * a guardrail/refusal, never a breach. These are regression tests: if a future
 * change weakens a guard, the matching probe turns from guardrail into breach.
 */
describe('T50 — Red-Team Sweep (Milestone B3)', () => {
  let tmpDir: string;
  let db: DbConnection & { close: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t50-'));
    db = createRealSqliteDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. Output exfiltration: secrets are scrubbed from child env and redacted from output', () => {
    const hostileEnv = {
      PATH: '/usr/bin',
      GOOGLE_API_KEY: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
      ANTHROPIC_API_KEY: 'sk-ant-super-secret-value-000000000000',
      BUREAU_SECRET: 'bureau-secret-do-not-leak',
      HARMLESS: 'ok'
    };
    const clean = scrubEnv(hostileEnv);
    // The guard: no secret key survives into the child environment.
    expect(clean.GOOGLE_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.BUREAU_SECRET).toBeUndefined();
    // ...but harmless vars pass through, so the child still works.
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.HARMLESS).toBe('ok');

    // Even if a secret reaches output text, it is redacted before journaling.
    const leaked = 'error near AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 and GOOGLE_API_KEY=hunter2';
    const safe = redactOutput(leaked);
    expect(safe).not.toContain('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456');
    expect(safe).not.toContain('hunter2');
    expect(safe).toContain('[REDACTED]');
  });

  it('2. Selector spoofing: a non-calibrated selector is refused by the gate, inner driver never called', async () => {
    let innerCalls = 0;
    const recordingDriver: IdeDriver = {
      async launch() {},
      async navigate() {},
      async read(): Promise<IdeDriverReadResult> { innerCalls++; return { text: 'x' } as IdeDriverReadResult; },
      async act(): Promise<IdeDriverActResult> { innerCalls++; return {} as IdeDriverActResult; },
      async snapshot(): Promise<IdeDriverSnapshotResult> { return {} as IdeDriverSnapshotResult; },
      async close() {}
    };
    const now = new Date().toISOString();
    // Attacker plants an un-calibrated selector row (status 'draft') hoping the
    // gate trusts its mere existence. Only 'calibrated' may act.
    db.run(
      `INSERT INTO bureau_selectors (id, key, css, status, actor_role, provider, model, created_at, updated_at)
       VALUES ('sel-1','send-button','#send','draft','system','deterministic','core',?,?)`,
      now, now
    );
    const gated = new GatedIdeDriver(recordingDriver, db);

    await expect(gated.read('send-button')).rejects.toBeInstanceOf(UncalibratedSelectorError);
    await expect(gated.act('send-button', 'click' as IdeDriverAction)).rejects.toBeInstanceOf(UncalibratedSelectorError);
    expect(innerCalls).toBe(0);

    // The refusals were journaled as guardrail spans.
    const guardrails = db.all(`SELECT * FROM bureau_journal WHERE kind = 'guardrail'`);
    expect(guardrails.length).toBeGreaterThanOrEqual(2);
  });

  it('3. Verify-command tampering: the verifier reads its command from the DB and refuses empty/vacuous', async () => {
    const now = new Date().toISOString();
    // Task with NO verify_cmd — a workspace-planted script must not become the command.
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, verify_cmd, created_at, updated_at)
       VALUES ('t-novc','No verify cmd','verifying','w1',NULL,?,?)`, now, now
    );
    await expect(runVerifier(db, 't-novc', tmpDir)).rejects.toThrow(/no verify_cmd/i);

    // Task whose verify_cmd is vacuous (a no-op the attacker hopes passes trivially).
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, verify_cmd, created_at, updated_at)
       VALUES ('t-vac','Vacuous','verifying','w2','true',?,?)`, now, now
    );
    await expect(runVerifier(db, 't-vac', tmpDir)).rejects.toThrow(/vacuous and refused/i);
  });
});
