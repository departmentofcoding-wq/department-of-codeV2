import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple } from '../../engine/contract/index.ts';
import { createSession } from '../../engine/intake/index.ts';
import { getModelAttributionRollups } from '../../engine/ledger/rollups.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { runOfficerTurn } from '../../engine/officers/task_intake_officer.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t16-test-'));
      const dbPath = path.join(tmpDir, 'test.db');
      const db = createRealSqliteDb(dbPath);
      return {
        db,
        cleanup: () => {
          db.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      };
    }
  }
];

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

describe.each(testImplementations)('T16: Attribution Exactness ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('matches ledger rollups for officer model with reported mock tokens exactly', async () => {
    const session = createSession(db, { title: 'Attribution Test Task', attribution: humanAttr });

    const expectedTokensIn1 = 142;
    const expectedTokensOut1 = 68;
    const expectedTokensIn2 = 215;
    const expectedTokensOut2 = 91;

    const mockClient = new MockClient([
      { text: 'Turn 1', tokensIn: expectedTokensIn1, tokensOut: expectedTokensOut1, latencyMs: 15, costUsd: null, finishReason: 'stop', truncated: false },
      { text: 'Turn 2', tokensIn: expectedTokensIn2, tokensOut: expectedTokensOut2, latencyMs: 20, costUsd: null, finishReason: 'stop', truncated: false }
    ]);

    await runOfficerTurn(db, session.id, { customClient: mockClient });
    await runOfficerTurn(db, session.id, { customClient: mockClient });

    const rollups = getModelAttributionRollups(db);
    expect(rollups.length).toBeGreaterThan(0);

    const officerRollup = rollups.find((r) => r.acts > 0);
    expect(officerRollup).toBeDefined();
    expect(officerRollup?.acts).toBe(2);
    expect(officerRollup?.tokens_in).toBe(expectedTokensIn1 + expectedTokensIn2);
    expect(officerRollup?.tokens_out).toBe(expectedTokensOut1 + expectedTokensOut2);
  });
});
