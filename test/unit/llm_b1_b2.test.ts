import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUDGET_META_KEYS } from '../../engine/contract/constants.ts';
import { LlmError } from '../../engine/contract/index.ts';
import { closeDatabase, openDbConnection } from '../../engine/db/index.ts';
import { callModel } from '../../engine/llm/call_model.ts';
import { GoogleClient } from '../../engine/llm/google_client.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { assignRole, registerModel } from '../../engine/models/registry.ts';

describe('Stream B1 & B2 — LLM Infrastructure & callModel', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-llm-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('callModel: executes successfully on mockClient and records attributed llm span', async () => {
    const db = openDbConnection(dbPath);
    const mock = new MockClient([
      {
        text: 'Hello from mock officer',
        tokensIn: 50,
        tokensOut: 20,
        latencyMs: 100,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      }
    ]);

    const res = await callModel(
      db,
      'task-intake-officer',
      [{ role: 'user', content: 'hello' }],
      [],
      { customClient: mock }
    );

    expect(res.text).toBe('Hello from mock officer');
    expect(res.tokensIn).toBe(50);
    expect(res.tokensOut).toBe(20);

    // Verify journal span
    const span = db.get<any>('SELECT * FROM bureau_journal WHERE kind = ?', 'llm');
    expect(span).toBeDefined();
    expect(span.actor_role).toBe('task-intake-officer');
    expect(span.tokens_in).toBe(50);
    expect(span.tokens_out).toBe(20);
    expect(span.cost_usd).toBeNull();
  });

  it('callModel: budget check triggers before LLM call, emits guardrail span + notifies operator', async () => {
    const db = openDbConnection(dbPath);
    // Set budget ceiling low
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES (?, ?)`,
      BUDGET_META_KEYS.ROLLING_24H_TOKENS_CEILING,
      '10'
    );

    // Seed prior journal span that exceeds ceiling
    db.run(`
      INSERT INTO bureau_journal (
        ts, kind, actor_role, provider, model, tokens_in, tokens_out, detail
      ) VALUES (
        ?, 'llm', 'task-intake-officer', 'ollama', 'ollama/qwen2.5-coder', 10, 10, '{}'
      )
    `, new Date().toISOString());

    const mock = new MockClient();

    await expect(
      callModel(db, 'task-intake-officer', [{ role: 'user', content: 'test' }], [], {
        customClient: mock
      })
    ).rejects.toThrow(/ceiling exceeded/i);

    // Assert zero mock calls were made
    expect(mock.callHistory).toHaveLength(0);

    // Assert guardrail span was logged
    const guardrail = db.get<any>('SELECT * FROM bureau_journal WHERE kind = ?', 'guardrail');
    expect(guardrail).toBeDefined();
    expect(guardrail.detail).toContain('budget_exceeded');
  });

  it('callModel: 429 rate limit triggers cooldown in bureau_meta, emits guardrail span, and rotates', async () => {
    const db = openDbConnection(dbPath);

    // Register two custom models for a custom role
    registerModel(db, {
      id: 'm1',
      provider: 'ollama',
      display: 'Model 1',
      enabled: 1
    });
    registerModel(db, {
      id: 'm2',
      provider: 'google',
      display: 'Model 2',
      enabled: 1
    });

    // Disable default seeded models for clean test isolation
    db.run(`UPDATE bureau_models SET enabled = 0 WHERE id NOT IN ('m1', 'm2')`);

    assignRole(db, 'custom-officer', 'ollama', 'm1');

    // Set mock to return 429 on first attempt, then success on second
    const mock = new MockClient([
      new LlmError('rate-limited', '429 Quota', 50000),
      {
        text: 'Success on model 2',
        tokensIn: 30,
        tokensOut: 15,
        latencyMs: 80,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      }
    ]);

    // Set fake key so m2 (google) is active
    process.env.GOOGLE_API_KEY = 'fake-key-for-test';
    try {
      const res = await callModel(
        db,
        'custom-officer',
        [{ role: 'user', content: 'test' }],
        [],
        { customClient: mock }
      );

      expect(res.text).toBe('Success on model 2');

      // Check cooldown recorded for m1 in bureau_meta
      const cooldownRow = db.get<any>(
        'SELECT value FROM bureau_meta WHERE key = ?',
        'cooldown:m1'
      );
      expect(cooldownRow).toBeDefined();
      expect(new Date(cooldownRow.value).getTime()).toBeGreaterThan(Date.now());

      // Check guardrail span for m1
      const guardrail = db.get<any>(
        'SELECT * FROM bureau_journal WHERE kind = ? AND model = ?',
        'guardrail',
        'm1'
      );
      expect(guardrail).toBeDefined();
      expect(guardrail.detail).toContain('quota_exceeded_cooldown');

      // Check llm span for m2
      const llmSpan = db.get<any>(
        'SELECT * FROM bureau_journal WHERE kind = ? AND model = ?',
        'llm',
        'm2'
      );
      expect(llmSpan).toBeDefined();
    } finally {
      delete process.env.GOOGLE_API_KEY;
    }
  });

  it('GoogleClient: sanitizes errors and never echoes request body or headers (Key Hygiene)', async () => {
    const client = new GoogleClient('http://127.0.0.1:9999'); // Invalid endpoint
    process.env.GOOGLE_API_KEY = 'AIzaSySecretTestKey12345';

    try {
      await client.complete({
        modelId: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }]
      });
      expect.fail('Should have thrown LlmError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(LlmError);
      expect(err.message).not.toContain('AIzaSySecretTestKey12345');
    } finally {
      delete process.env.GOOGLE_API_KEY;
    }
  });
});
