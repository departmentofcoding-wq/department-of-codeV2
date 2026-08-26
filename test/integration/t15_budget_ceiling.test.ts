import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_META_KEYS, type AttributionTuple, type BureauJournalRow } from '../../engine/contract/index.ts';
import { createSession } from '../../engine/intake/index.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { runOfficerTurn } from '../../engine/officers/task_intake_officer.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t15-test-'));
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

describe.each(testImplementations)('T15: Budget Ceiling Enforcement ($name)', ({ create }) => {
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

  it('declines with guardrail span + notifies operator when over budget; no call made beyond ceiling', async () => {
    // 1. Set request budget ceiling low: 2 requests allowed
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      BUDGET_META_KEYS.ROLLING_24H_REQUESTS_CEILING,
      '2'
    );

    const session = createSession(db, { title: 'Budget Test', attribution: humanAttr });

    const mockClient = new MockClient([
      { text: 'Turn 1 response', tokensIn: 100, tokensOut: 50, latencyMs: 10, costUsd: null, finishReason: 'stop', truncated: false },
      { text: 'Turn 2 response', tokensIn: 100, tokensOut: 50, latencyMs: 10, costUsd: null, finishReason: 'stop', truncated: false },
      { text: 'Turn 3 response (should be blocked)', tokensIn: 100, tokensOut: 50, latencyMs: 10, costUsd: null, finishReason: 'stop', truncated: false }
    ]);

    // Turn 1: Succeeded (1 request used)
    await runOfficerTurn(db, session.id, { customClient: mockClient });
    expect(mockClient.callHistory).toHaveLength(1);

    // Turn 2: Succeeded (2 requests used, reaches ceiling)
    await runOfficerTurn(db, session.id, { customClient: mockClient });
    expect(mockClient.callHistory).toHaveLength(2);

    // Turn 3: MUST throw Error because 24h request ceiling (2) is reached
    await expect(runOfficerTurn(db, session.id, { customClient: mockClient })).rejects.toThrow(/ceiling exceeded/);

    // Assert NO call beyond ceiling was made to mock client (callHistory length remains 2)
    expect(mockClient.callHistory).toHaveLength(2);

    // Assert guardrail span was journaled
    const spans = db.all<BureauJournalRow>(`SELECT * FROM bureau_journal WHERE kind = 'guardrail'`);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.detail.includes('budget_exceeded'))).toBe(true);
  });

  it('declines on the rolling-24h TOKEN ceiling too (not just requests)', async () => {
    // One turn spends 150 tokens (100 in + 50 out). A ceiling of 120 is already
    // exceeded after turn 1, so turn 2 must be refused before any call.
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      BUDGET_META_KEYS.ROLLING_24H_TOKENS_CEILING,
      '120'
    );

    const session = createSession(db, { title: 'Token Budget Test', attribution: humanAttr });
    const mockClient = new MockClient([
      { text: 'Turn 1', tokensIn: 100, tokensOut: 50, latencyMs: 10, costUsd: null, finishReason: 'stop', truncated: false },
      { text: 'Turn 2 (blocked)', tokensIn: 100, tokensOut: 50, latencyMs: 10, costUsd: null, finishReason: 'stop', truncated: false }
    ]);

    await runOfficerTurn(db, session.id, { customClient: mockClient });
    expect(mockClient.callHistory).toHaveLength(1);

    await expect(runOfficerTurn(db, session.id, { customClient: mockClient })).rejects.toThrow(/ceiling exceeded/);
    expect(mockClient.callHistory).toHaveLength(1); // no call beyond the token ceiling

    const spans = db.all<BureauJournalRow>(`SELECT * FROM bureau_journal WHERE kind = 'guardrail'`);
    expect(spans.some((s) => s.detail.includes('budget_exceeded') && s.detail.includes('token'))).toBe(true);
  });
});
