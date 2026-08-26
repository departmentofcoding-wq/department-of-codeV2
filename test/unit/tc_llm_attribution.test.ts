import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { getModelAttributionRollups } from '../../engine/ledger/rollups.ts';
import { journal } from '../../engine/journal/writer.ts';

/**
 * tc_llm_attribution — a model id must never embed its own provider.
 *
 * The provider lives in its own column; a prefixed id (the shipped
 * 'ollama/qwen2.5-coder') doubled the provider in the (provider, model) rollup
 * key and was sent verbatim to Ollama as a malformed model name. This locks the
 * clean seed and the boot-door heal for existing DBs.
 */
describe('tc_llm_attribution: model ids never embed their provider', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function freshDbPath(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-tc-attr-'));
    return path.join(tempDir, 'test.db');
  }

  it('no seeded model id carries its own "<provider>/" prefix', () => {
    const db = openDbConnection(freshDbPath());
    const models = db.all<{ id: string; provider: string }>('SELECT id, provider FROM bureau_models');
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id.startsWith(m.provider + '/'), `model id '${m.id}' embeds its provider '${m.provider}'`).toBe(false);
    }
  });

  it('the boot door heals a pre-existing prefixed id, repointing its assignment', () => {
    const dbPath = freshDbPath();
    let db = openDbConnection(dbPath);

    // Simulate a legacy DB: replace the clean row with the old prefixed one and
    // point a role assignment at it.
    db.run("DELETE FROM bureau_models WHERE id = 'qwen2.5-coder'");
    db.run(
      `INSERT INTO bureau_models (id, provider, display, enabled, notes)
       VALUES ('ollama/qwen2.5-coder', 'ollama', 'Qwen 2.5 Coder (Ollama)', 1, 'legacy')`
    );
    db.run(
      `INSERT INTO bureau_assignments (role, backend, model_id, updated_at)
       VALUES ('task-intake-officer', 'ollama', 'ollama/qwen2.5-coder', ?)
       ON CONFLICT(role) DO UPDATE SET model_id = 'ollama/qwen2.5-coder', backend = 'ollama'`,
      new Date().toISOString()
    );

    // Reopen so the boot door (applyBootMigrations → normalizeModelIds) runs.
    closeDatabase();
    db = openDbConnection(dbPath);

    const legacy = db.get('SELECT id FROM bureau_models WHERE id = ?', 'ollama/qwen2.5-coder');
    expect(legacy, 'the prefixed model row should be gone').toBeFalsy();
    const clean = db.get('SELECT id FROM bureau_models WHERE id = ?', 'qwen2.5-coder');
    expect(clean, 'the clean model row should exist').toBeTruthy();
    const assignment = db.get<{ model_id: string }>(
      "SELECT model_id FROM bureau_assignments WHERE role = 'task-intake-officer'"
    );
    expect(assignment?.model_id).toBe('qwen2.5-coder');
  });

  it('rollups group a clean model as (ollama, qwen2.5-coder) — provider appears once', () => {
    const db = openDbConnection(freshDbPath());
    journal(db, {
      kind: 'llm',
      attribution: { actor_role: 'task-intake-officer', provider: 'ollama', model: 'qwen2.5-coder', account: null },
      tokensIn: 10,
      tokensOut: 5
    });

    const rollups = getModelAttributionRollups(db);
    const ollama = rollups.filter((r) => r.provider === 'ollama');
    expect(ollama.length).toBe(1);
    expect(ollama[0].model).toBe('qwen2.5-coder');
    // The provider is not repeated inside the model key.
    expect(ollama[0].model.includes('ollama/')).toBe(false);
  });
});
