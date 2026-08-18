import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mintNonce,
  setIdeDriverOverride,
  type IdeDriver,
  type IdeDriverActResult
} from '../../engine/contract/index.ts';
import { wrapDatabaseSync } from '../../engine/db/adapter.ts';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';
import {
  queryCorrelatedChain,
  recordCorrelatedObservation,
  registerSelector
} from '../../engine/selectors/index.ts';

class NonceEchoDriver implements IdeDriver {
  async launch(): Promise<void> {}
  async navigate(): Promise<void> {}
  async read(): Promise<any> {
    return { matchCount: 1, nonceEcho: mintNonce() };
  }
  async act(selectorKey: string, action?: string, value?: string): Promise<IdeDriverActResult> {
    return { success: true, nonceEcho: mintNonce() };
  }
  async snapshot() {
    return { outline: '<div></div>' };
  }
  async close(): Promise<void> {}
}

describe('T34: Nonce Correlation Integration Test', () => {
  let tmpDir: string;
  let rawDb: DatabaseSync;
  let db: ReturnType<typeof wrapDatabaseSync>;
  let driver: NonceEchoDriver;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t34-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    rawDb = new DatabaseSync(dbPath);
    applySchema(rawDb);
    applyBootMigrations(rawDb);
    db = wrapDatabaseSync(rawDb);

    driver = new NonceEchoDriver();
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

  it('verifies triple equality: span.detail.nonce === observation.nonce === result.nonceEcho', async () => {
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at)
      VALUES ('t-34', 'T34 Task', 'u-34', '${now}', '${now}');

      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, created_at)
      VALUES ('disp-34', 't-34', 'u-34', 'junior-engineer', 'ollama', 'qwen', '${now}');
    `);

    registerSelector(db, { key: 'btn.target', css: '#target' });

    // Action 1
    const actResult = await driver.act('btn.target', 'click');
    const nonceEcho = actResult.nonceEcho!;

    const obsRow = recordCorrelatedObservation(db, {
      dispatchId: 'disp-34',
      selectorKey: 'btn.target',
      action: 'click',
      nonceEcho,
      observed: { clicked: true },
      attribution: { actor_role: 'junior-engineer', provider: 'ollama', model: 'qwen', account: null },
      taskId: 't-34'
    });

    const chainResult = queryCorrelatedChain(db, 'disp-34');
    expect(chainResult.dispatch).not.toBeNull();
    expect(chainResult.pairs.length).toBe(1);

    const pair = chainResult.pairs[0];
    const spanDetail = JSON.parse(pair.span.detail);

    // TRIPLE EQUALITY ASSERTION
    expect(spanDetail.nonce).toBe(obsRow.nonce);
    expect(obsRow.nonce).toBe(actResult.nonceEcho);
    expect(spanDetail.nonce).toBe(actResult.nonceEcho);
  });
});
