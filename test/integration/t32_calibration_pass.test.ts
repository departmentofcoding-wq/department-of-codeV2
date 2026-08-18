import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mintNonce,
  setIdeDriverOverride,
  type IdeDriver,
  type IdeDriverReadResult
} from '../../engine/contract/index.ts';
import { wrapDatabaseSync } from '../../engine/db/adapter.ts';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';
import { claimJob, completeJob } from '../../engine/jobs/jobs.ts';
import {
  enqueueSelectorCalibration,
  getSelector,
  registerSelector,
  selectorCalibrateHandler
} from '../../engine/selectors/index.ts';

class StableIdeDriver implements IdeDriver {
  public readCount = 0;

  async launch(): Promise<void> {}
  async navigate(): Promise<void> {}

  async read(selectorKey: string): Promise<IdeDriverReadResult> {
    this.readCount++;
    return {
      matchCount: 1,
      text: 'Submit Button',
      nonceEcho: mintNonce()
    };
  }

  async act() {
    return { success: true, nonceEcho: mintNonce() };
  }

  async snapshot() {
    return { outline: '<button id="submit">Submit</button>' };
  }

  async close(): Promise<void> {}
}

describe('T32: Selector Calibration Pass Integration Test', () => {
  let tmpDir: string;
  let rawDb: DatabaseSync;
  let db: ReturnType<typeof wrapDatabaseSync>;
  let driver: StableIdeDriver;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t32-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);
    applyBootMigrations(rawDb);
    db = wrapDatabaseSync(rawDb);

    driver = new StableIdeDriver();
    setIdeDriverOverride(driver);
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

  it('calibrates a selector with exactly 1 stable match after N consistent reads', async () => {
    registerSelector(db, { key: 'btn.submit', css: 'button#submit' });

    const jobRow = enqueueSelectorCalibration(db, 'btn.submit', { maxReads: 3 });
    expect(jobRow.state).toBe('pending');

    const claimed = claimJob(db, 'runner-t32', 30000);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(jobRow.id);

    await selectorCalibrateHandler({
      db,
      job: claimed!,
      payload: JSON.parse(claimed!.payload),
      signal: new AbortController().signal
    });

    completeJob(db, claimed!.id);

    const selector = getSelector(db, 'btn.submit');
    expect(selector?.status).toBe('calibrated');
    expect(selector?.match_count).toBe(1);
    expect(selector?.attempts).toBe(1);
    expect(selector?.last_calibrated_at).not.toBeNull();

    expect(driver.readCount).toBe(3);

    const spans = db.all<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM bureau_journal WHERE kind = 'system' ORDER BY id DESC"
    );
    const calSpan = spans.find((s) => s.detail.includes('selector.calibrate'));
    expect(calSpan).toBeDefined();
    const detail = JSON.parse(calSpan!.detail);
    expect(detail.status).toBe('calibrated');
    expect(detail.matchCount).toBe(1);
  });
});
