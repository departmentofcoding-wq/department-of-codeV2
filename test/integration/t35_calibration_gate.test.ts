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
  registerSelector
} from '../../engine/selectors/index.ts';

class CountingDriver implements IdeDriver {
  public callCount = 0;

  async launch(): Promise<void> {}
  async navigate(): Promise<void> {}

  async read(selectorKey: string): Promise<IdeDriverReadResult> {
    this.callCount++;
    return { matchCount: 1, text: 'Sample', nonceEcho: mintNonce() };
  }

  async act(selectorKey: string): Promise<IdeDriverActResult> {
    this.callCount++;
    return { success: true, nonceEcho: mintNonce() };
  }

  async snapshot() {
    return { outline: '<div></div>' };
  }

  async close(): Promise<void> {}
}

describe('T35: Calibration Gate Integration Test', () => {
  let tmpDir: string;
  let rawDb: DatabaseSync;
  let db: ReturnType<typeof wrapDatabaseSync>;
  let innerDriver: CountingDriver;
  let gatedDriver: GatedIdeDriver;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t35-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);
    applyBootMigrations(rawDb);
    db = wrapDatabaseSync(rawDb);

    innerDriver = new CountingDriver();
    gatedDriver = new GatedIdeDriver(innerDriver, db);
    setIdeDriverOverride(gatedDriver);
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

  it('refuses actions on uncalibrated selectors, browser never sees them, and journals guardrail span', async () => {
    registerSelector(db, { key: 'btn.draft', css: '.uncalibrated-btn' });

    await expect(gatedDriver.act('btn.draft', 'click')).rejects.toThrow(UncalibratedSelectorError);
    await expect(gatedDriver.read('btn.draft')).rejects.toThrow(UncalibratedSelectorError);

    // Inner driver was NEVER touched
    expect(innerDriver.callCount).toBe(0);

    // Guardrail spans were recorded
    const spans = db.all<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM bureau_journal WHERE kind = 'guardrail'"
    );
    expect(spans.length).toBe(2);
    const detail = JSON.parse(spans[0].detail);
    expect(detail.action).toBe('gate_refusal');
    expect(detail.selectorKey).toBe('btn.draft');

    // Now calibrate the selector
    db.exec("UPDATE bureau_selectors SET status = 'calibrated', match_count = 1 WHERE key = 'btn.draft'");

    // Now act succeeds and inner driver call count increments
    const res = await gatedDriver.act('btn.draft', 'click');
    expect(res.success).toBe(true);
    expect(innerDriver.callCount).toBe(1);
  });
});
