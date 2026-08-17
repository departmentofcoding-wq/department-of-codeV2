import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmError, type AttributionTuple, type BureauJournalRow } from '../../engine/contract/index.ts';
import { callModel, getCandidateModels, isModelInCooldown } from '../../engine/llm/call_model.ts';
import { registerModel } from '../../engine/models/registry.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t17-test-'));
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

describe.each(testImplementations)('T17: Quota Rotation ($name)', ({ create }) => {
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

  it('rotates to second enabled model on 429, records cooldown, and refuses when all models cool', async () => {
    // 1. Seed two enabled models in registry
    registerModel(db, {
      id: 'model-primary-1',
      provider: 'ollama',
      display: 'Model Primary 1',
      enabled: 1
    });

    registerModel(db, {
      id: 'model-secondary-2',
      provider: 'ollama',
      display: 'Model Secondary 2',
      enabled: 1
    });

    const { assignRole } = await import('../../engine/models/registry.ts');
    assignRole(db, 'task-intake-officer', 'ollama', 'model-primary-1');

    // 2. Setup mock client where call 1 throws 429 rate-limited, call 2 succeeds
    let callCount = 0;
    const mockRotatingClient = {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          throw new LlmError('rate-limited', 'Quota exceeded for primary model', 60000);
        }
        return {
          text: 'Rotated model response',
          tokensIn: 50,
          tokensOut: 20,
          latencyMs: 15,
          costUsd: null,
          finishReason: 'stop' as const,
          truncated: false
        };
      }
    };

    // 3. callModel should encounter 429 on model-primary-1, set cooldown in bureau_meta, and rotate to model-secondary-2
    const res = await callModel(
      db,
      'task-intake-officer',
      [{ role: 'user', content: 'Hello' }],
      undefined,
      { customClient: mockRotatingClient }
    );

    expect(res.text).toBe('Rotated model response');

    // Assert primary model is in cooldown in bureau_meta
    expect(isModelInCooldown(db, 'model-primary-1')).toBe(true);

    // Assert guardrail span for quota_exceeded_cooldown was journaled
    const guardrailSpans = db.all<BureauJournalRow>(`SELECT * FROM bureau_journal WHERE kind = 'guardrail'`);
    expect(guardrailSpans.length).toBeGreaterThan(0);
    expect(guardrailSpans.some((s) => s.model === 'model-primary-1')).toBe(true);

    // Assert llm span for successful call was journaled
    const llmSpans = db.all<BureauJournalRow>(`SELECT * FROM bureau_journal WHERE kind = 'llm'`);
    expect(llmSpans.length).toBeGreaterThan(0);

    // 4. Set all candidate models in cooldown as well
    const candidates = getCandidateModels(db, 'task-intake-officer');
    for (const c of candidates) {
      db.run(
        `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        `cooldown:${c.id}`,
        new Date(Date.now() + 60000).toISOString()
      );
    }

    // 5. With every candidate model cooling, callModel MUST throw LlmError rather than hammering
    await expect(
      callModel(
        db,
        'task-intake-officer',
        [{ role: 'user', content: 'Hello again' }],
        undefined,
        { customClient: mockRotatingClient }
      )
    ).rejects.toThrow(/rate-limited|No enabled, non-cooldown model/);
  });
});
