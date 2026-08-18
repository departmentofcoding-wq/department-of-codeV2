import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mintNonce,
  setIdeDriverOverride,
  type IdeDriver,
  type IdeDriverActResult,
  type IdeDriverReadResult
} from '../../engine/contract/index.ts';
import { wrapDatabaseSync } from '../../engine/db/adapter.ts';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';
import {
  GatedIdeDriver,
  UncalibratedSelectorError,
  enqueueSelectorCalibration,
  getSelector,
  queryCorrelatedChain,
  recordCorrelatedObservation,
  registerSelector
} from '../../engine/selectors/index.ts';

class FakeIdeDriver implements IdeDriver {
  constructor(
    private readonly selectors: Record<string, { css: string; matchCount: number; text?: string }> = {}
  ) {}

  async launch(): Promise<void> {}
  async navigate(): Promise<void> {}

  async read(selectorKey: string): Promise<IdeDriverReadResult> {
    const sel = this.selectors[selectorKey];
    return {
      matchCount: sel?.matchCount ?? 0,
      text: sel?.text ?? '',
      nonceEcho: mintNonce()
    };
  }

  async act(selectorKey: string): Promise<IdeDriverActResult> {
    return {
      success: true,
      nonceEcho: mintNonce()
    };
  }

  async snapshot() {
    return { outline: '<div>fake</div>' };
  }

  async close(): Promise<void> {}
}

describe('Stream B Unit Tests: Registry, Gate, and Correlation', () => {
  let tmpDir: string;
  let rawDb: DatabaseSync;
  let db: ReturnType<typeof wrapDatabaseSync>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-selectors-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);
    applyBootMigrations(rawDb);
    db = wrapDatabaseSync(rawDb);
    setIdeDriverOverride(null);
  });

  afterEach(() => {
    setIdeDriverOverride(null);
    if (db) {
      try {
        db.close();
      } catch {
        // Ignored
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('B1: Selector Registry & Enqueue', () => {
    it('registers a selector in draft status with default attribution', () => {
      const selector = registerSelector(db, { key: 'btn.submit', css: 'button#submit' });
      expect(selector.key).toBe('btn.submit');
      expect(selector.css).toBe('button#submit');
      expect(selector.status).toBe('draft');
      expect(selector.match_count).toBe(0);
      expect(selector.attempts).toBe(0);
      expect(selector.actor_role).toBe('system');
    });

    it('queries registered selector via getSelector', () => {
      registerSelector(db, { key: 'input.username', css: 'input[name="user"]' });
      const sel = getSelector(db, 'input.username');
      expect(sel).not.toBeNull();
      expect(sel?.css).toBe('input[name="user"]');
    });

    it('enqueues a selector.calibrate job into bureau_jobs', () => {
      const job = enqueueSelectorCalibration(db, 'btn.submit', { maxReads: 3 });
      expect(job.kind).toBe('selector.calibrate');
      expect(JSON.parse(job.payload)).toEqual({ key: 'btn.submit', maxReads: 3 });
    });
  });

  describe('B2: Calibration Gate', () => {
    it('allows read and act when selector is calibrated', async () => {
      registerSelector(db, { key: 'btn.submit', css: '#submit' });
      db.exec("UPDATE bureau_selectors SET status = 'calibrated', match_count = 1 WHERE key = 'btn.submit'");

      const fakeDriver = new FakeIdeDriver({ 'btn.submit': { css: '#submit', matchCount: 1 } });
      const gatedDriver = new GatedIdeDriver(fakeDriver, db);

      await expect(gatedDriver.read('btn.submit')).resolves.toHaveProperty('matchCount', 1);
      await expect(gatedDriver.act('btn.submit', 'click')).resolves.toHaveProperty('success', true);
    });

    it('refuses read and act when selector is in draft/failed or unregistered status', async () => {
      registerSelector(db, { key: 'btn.draft', css: '.draft' });
      const fakeDriver = new FakeIdeDriver();
      const gatedDriver = new GatedIdeDriver(fakeDriver, db);

      await expect(gatedDriver.read('btn.draft')).rejects.toThrow(UncalibratedSelectorError);
      await expect(gatedDriver.act('btn.draft', 'click')).rejects.toThrow(UncalibratedSelectorError);
      await expect(gatedDriver.act('unregistered.key', 'click')).rejects.toThrow(UncalibratedSelectorError);

      const guardrails = db.all<{ detail: string }>(
        "SELECT detail FROM bureau_journal WHERE kind = 'guardrail'"
      );
      expect(guardrails.length).toBe(3);
    });
  });

  describe('B3: Nonce Correlation', () => {
    it('consumes driver nonceEcho to write dispatch span and observation row', () => {
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
        VALUES ('t-1', 'Task 1', 'u-1', '${now}', '${now}');

        INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
        VALUES ('disp-1', 't-1', 'u-1', 'junior-engineer', 'ollama', 'qwen', '${now}');
      `);

      const nonceEcho = mintNonce();
      const obsRow = recordCorrelatedObservation(db, {
        dispatchId: 'disp-1',
        selectorKey: 'btn.submit',
        action: 'click',
        nonceEcho,
        observed: { clicked: true },
        attribution: { actor_role: 'junior-engineer', provider: 'ollama', model: 'qwen', account: null },
        taskId: 't-1'
      });

      expect(obsRow.nonce).toBe(nonceEcho);

      const chain = queryCorrelatedChain(db, 'disp-1');
      expect(chain.dispatch?.id).toBe('disp-1');
      expect(chain.pairs.length).toBe(1);
      expect(chain.pairs[0].nonce).toBe(nonceEcho);
      expect(JSON.parse(chain.pairs[0].span.detail).nonce).toBe(nonceEcho);
    });
  });
});
