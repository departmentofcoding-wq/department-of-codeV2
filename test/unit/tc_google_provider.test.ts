import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmError, type BureauJournalRow } from '../../engine/contract/index.ts';
import { callModel, eligibleGoogleKeyPairs, isModelInCooldown, googlePairUsage } from '../../engine/llm/call_model.ts';
import { getGoogleKeys, isValidGoogleKey, maskGoogleKey, saveGoogleKeys, loadGoogleKeysFromDisk } from '../../engine/llm/google_keys.ts';
import { registerModel, assignRole } from '../../engine/models/registry.ts';
import { journal } from '../../engine/journal/writer.ts';
import { createFakeDb } from '../fixtures/db_factory.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

const KEY_A = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01';
const KEY_B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB02';

function seedLiteModel(db: DbConnection) {
  registerModel(db, { id: 'gemini-3.1-flash-lite', provider: 'google', display: 'Lite', enabled: 1 });
  assignRole(db, 'task-intake-officer', 'google', 'gemini-3.1-flash-lite');
}

/** Emit N successful llm spans for a (model, key slot) to drive the selector. */
function emitLlmSpans(db: DbConnection, model: string, account: string, n: number, tokensIn = 1) {
  for (let i = 0; i < n; i++) {
    journal(db, {
      kind: 'llm',
      attribution: { actor_role: 'task-intake-officer', provider: 'google', model, account },
      tokensIn,
      tokensOut: 1
    });
  }
}

/** Insert N llm spans timestamped `ageMs` in the past (counts for RPD, not RPM). */
function emitAgedLlmSpans(db: DbConnection, model: string, account: string, n: number, ageMs: number) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  for (let i = 0; i < n; i++) {
    db.run(
      `INSERT INTO bureau_journal (ts, kind, actor_role, provider, model, account, tokens_in, tokens_out, detail)
       VALUES (?, 'llm', 'task-intake-officer', 'google', ?, ?, 1, 1, '{}')`,
      ts, model, account
    );
  }
}

describe('Google provider: multi-key rotation, steering, and hygiene', () => {
  let db: DbConnection & { close: () => void };
  const savedEnv = {
    keys: process.env.GOOGLE_API_KEYS,
    legacy: process.env.GOOGLE_API_KEY,
    file: process.env.BUREAU_GOOGLE_KEYS_FILE
  };

  beforeEach(() => {
    db = createFakeDb();
    delete process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEYS = `${KEY_A},${KEY_B}`;
  });

  afterEach(() => {
    db.close();
    process.env.GOOGLE_API_KEYS = savedEnv.keys;
    process.env.GOOGLE_API_KEY = savedEnv.legacy;
    process.env.BUREAU_GOOGLE_KEYS_FILE = savedEnv.file;
    if (savedEnv.keys === undefined) delete process.env.GOOGLE_API_KEYS;
    if (savedEnv.legacy === undefined) delete process.env.GOOGLE_API_KEY;
    if (savedEnv.file === undefined) delete process.env.BUREAU_GOOGLE_KEYS_FILE;
  });

  it('rotates to the second key on 429, cools the specific (model,key) pair, and attributes the serving slot', async () => {
    seedLiteModel(db);
    let call = 0;
    const client = {
      complete: async () => {
        call++;
        if (call === 1) throw new LlmError('rate-limited', 'quota', 1000);
        return { text: 'ok', tokensIn: 10, tokensOut: 5, latencyMs: 5, costUsd: null, finishReason: 'stop' as const, truncated: false };
      }
    };

    const res = await callModel(db, 'task-intake-officer', [{ role: 'user', content: 'hi' }], undefined, { customClient: client });
    expect(res.text).toBe('ok');

    // Pair (model, key0) cooled; key1 not.
    expect(isModelInCooldown(db, 'gemini-3.1-flash-lite:0')).toBe(true);
    expect(isModelInCooldown(db, 'gemini-3.1-flash-lite:1')).toBe(false);

    const llm = db.get<BureauJournalRow>("SELECT * FROM bureau_journal WHERE kind = 'llm' ORDER BY id DESC LIMIT 1");
    expect(llm?.account).toBe('gkey-1');
    const guard = db.get<BureauJournalRow>("SELECT * FROM bureau_journal WHERE kind = 'guardrail' ORDER BY id DESC LIMIT 1");
    expect(guard?.account).toBe('gkey-0');
  });

  it('throws rate-limited and cools both pairs when every key 429s', async () => {
    seedLiteModel(db);
    const client = { complete: async () => { throw new LlmError('rate-limited', 'quota', 1000); } };
    const err = await callModel(db, 'task-intake-officer', [{ role: 'user', content: 'hi' }], undefined, { customClient: client })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('rate-limited');
    expect(isModelInCooldown(db, 'gemini-3.1-flash-lite:0')).toBe(true);
    expect(isModelInCooldown(db, 'gemini-3.1-flash-lite:1')).toBe(true);
  });

  it('proactively skips a key slot at its daily cap (RPD steering)', async () => {
    seedLiteModel(db);
    // Key 0 has spent its 500 RPD earlier today (aged so RPM is clear — this
    // isolates the daily cap from the per-minute cap).
    emitAgedLlmSpans(db, 'gemini-3.1-flash-lite', 'gkey-0', 500, 2 * 60 * 60 * 1000);

    const pairs = eligibleGoogleKeyPairs(db, 'gemini-3.1-flash-lite', [KEY_A, KEY_B]);
    expect(pairs.map(p => p.keyIndex)).toEqual([1]);

    // And callModel routes to key1 without ever trying the exhausted key0.
    const client = { complete: async () => ({ text: 'ok', tokensIn: 1, tokensOut: 1, latencyMs: 1, costUsd: null, finishReason: 'stop' as const, truncated: false }) };
    await callModel(db, 'task-intake-officer', [{ role: 'user', content: 'hi' }], undefined, { customClient: client });
    const llm = db.get<BureauJournalRow>("SELECT * FROM bureau_journal WHERE kind = 'llm' ORDER BY id DESC LIMIT 1");
    expect(llm?.account).toBe('gkey-1');
  });

  it('proactively skips a key slot over its per-minute cap (RPM steering)', () => {
    seedLiteModel(db);
    emitLlmSpans(db, 'gemini-3.1-flash-lite', 'gkey-0', 15); // RPM cap for lite = 15
    const pairs = eligibleGoogleKeyPairs(db, 'gemini-3.1-flash-lite', [KEY_A, KEY_B]);
    expect(pairs.map(p => p.keyIndex)).toEqual([1]);
    const usage = googlePairUsage(db, 'gemini-3.1-flash-lite', 0);
    expect(usage.rpm).toBe(15);
  });

  it('never writes key material to the journal — only the gkey-N slot label', async () => {
    seedLiteModel(db);
    const client = { complete: async () => { throw new LlmError('rate-limited', 'quota', 1000); } };
    await expect(
      callModel(db, 'task-intake-officer', [{ role: 'user', content: 'hi' }], undefined, { customClient: client })
    ).rejects.toThrow();

    const rows = db.all<BureauJournalRow>('SELECT * FROM bureau_journal');
    for (const r of rows) {
      const blob = JSON.stringify(r);
      expect(blob).not.toContain(KEY_A);
      expect(blob).not.toContain(KEY_B);
    }
  });
});

describe('Google keys module: parsing, validation, masking, persistence', () => {
  const savedEnv = {
    keys: process.env.GOOGLE_API_KEYS,
    legacy: process.env.GOOGLE_API_KEY,
    file: process.env.BUREAU_GOOGLE_KEYS_FILE
  };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-gkeys-'));
    process.env.BUREAU_GOOGLE_KEYS_FILE = path.join(tmpDir, 'google.env');
    delete process.env.GOOGLE_API_KEYS;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.GOOGLE_API_KEYS = savedEnv.keys;
    process.env.GOOGLE_API_KEY = savedEnv.legacy;
    process.env.BUREAU_GOOGLE_KEYS_FILE = savedEnv.file;
    if (savedEnv.keys === undefined) delete process.env.GOOGLE_API_KEYS;
    if (savedEnv.legacy === undefined) delete process.env.GOOGLE_API_KEY;
    if (savedEnv.file === undefined) delete process.env.BUREAU_GOOGLE_KEYS_FILE;
  });

  it('parses comma-separated keys plus the legacy single key, de-duplicated', () => {
    process.env.GOOGLE_API_KEYS = `${KEY_A}, ${KEY_B}`;
    process.env.GOOGLE_API_KEY = KEY_A; // duplicate, should not appear twice
    expect(getGoogleKeys()).toEqual([KEY_A, KEY_B]);
  });

  it('validates and masks keys', () => {
    expect(isValidGoogleKey(KEY_A)).toBe(true);
    expect(isValidGoogleKey('nope')).toBe(false);
    expect(maskGoogleKey(KEY_A)).toBe('AIza…AA01');
    expect(maskGoogleKey(KEY_A)).not.toContain(KEY_A.slice(4, -4));
  });

  it('saves keys to the gitignored file + env and round-trips via loader', () => {
    const status = saveGoogleKeys([KEY_A, KEY_B]);
    expect(status.count).toBe(2);
    expect(process.env.GOOGLE_API_KEYS).toBe(`${KEY_A},${KEY_B}`);

    const fileText = fs.readFileSync(process.env.BUREAU_GOOGLE_KEYS_FILE!, 'utf8');
    expect(fileText).toContain(`GOOGLE_API_KEYS=${KEY_A},${KEY_B}`);

    // Loader repopulates env from disk when unset.
    delete process.env.GOOGLE_API_KEYS;
    loadGoogleKeysFromDisk();
    expect(getGoogleKeys()).toEqual([KEY_A, KEY_B]);
  });

  it('rejects invalid keys without writing anything', () => {
    expect(() => saveGoogleKeys(['not-a-key'])).toThrow(/valid Google API key/);
    expect(fs.existsSync(process.env.BUREAU_GOOGLE_KEYS_FILE!)).toBe(false);
  });
});
