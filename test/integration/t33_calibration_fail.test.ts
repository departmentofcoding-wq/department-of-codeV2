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
import { claimJob, failJob } from '../../engine/jobs/jobs.ts';
import {
  enqueueSelectorCalibration,
  getSelector,
  registerSelector,
  selectorCalibrateHandler
} from '../../engine/selectors/index.ts';

class AmbiguousIdeDriver implements IdeDriver {
  public readCount = 0;

  async launch(): Promise<void> {}
  async navigate(): Promise<void> {}

  async read(selectorKey: string): Promise<IdeDriverReadResult> {
    this.readCount++;
    return {
      matchCount: 2, // Ambiguous! 2 matches on target page
      text: 'Duplicate',
      nonceEcho: mintNonce()
    };
  }

  async act() {
    return { success: true, nonceEcho: mintNonce() };
  }

  async snapshot() {
    return { outline: '<div><button class="btn"></button><button class="btn"></button></div>' };
  }

  async close(): Promise<void> {}
}

describe('T33: Selector Calibration Fail Integration Test', () => {
  let tmpDir: string;
  let rawDb: DatabaseSync;
  let db: ReturnType<typeof wrapDatabaseSync>;
  let driver: AmbiguousIdeDriver;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t33-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);
    applyBootMigrations(rawDb);
    db = wrapDatabaseSync(rawDb);

    driver = new AmbiguousIdeDriver();
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

  it('fails calibration for an ambiguous selector and records evidence in job last_error and journal', async () => {
    registerSelector(db, { key: 'btn.ambiguous', css: '.btn' });

    const jobRow = enqueueSelectorCalibration(db, 'btn.ambiguous', { maxReads: 3 });
    const claimed = claimJob(db, 'runner-t33', 30000)!;

    let errMessage = '';
    try {
      await selectorCalibrateHandler({
        db,
        job: claimed,
        payload: JSON.parse(claimed.payload),
        signal: new AbortController().signal
      });
    } catch (err: any) {
      errMessage = err.message;
    }

    expect(errMessage).toContain('observed match count 2');

    const { job: failedJob } = failJob(db, claimed.id, errMessage, 1000);
    expect(failedJob.last_error).toContain('observed match count 2');

    const selector = getSelector(db, 'btn.ambiguous');
    expect(selector?.status).toBe('failed');
    expect(selector?.match_count).toBe(2);
    expect(selector?.attempts).toBe(1);

    // Stops after first non-1 read
    expect(driver.readCount).toBe(1);

    const spans = db.all<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM bureau_journal WHERE kind = 'guardrail' ORDER BY id DESC"
    );
    expect(spans.length).toBeGreaterThan(0);
    const detail = JSON.parse(spans[0].detail);
    expect(detail.status).toBe('failed');
    expect(detail.matchCount).toBe(2);
  });
});
