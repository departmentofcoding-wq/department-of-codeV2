import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDbConnection, closeDatabase } from '../db/index.ts';
import { seedModelsAndAssignments, seedPhase1OfficerRoster, getModel, getAssignment } from './index.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('A5: Model Registry & Assignments', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-models-'));
    dbPath = path.join(tempDir, 'test.db');
    const db = openDbConnection(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('A5: seeds senior-engineer → glm-5.2/zai/zcode and leaves pricing NULL (never 0)', () => {
    const db = openDbConnection(dbPath);
    seedModelsAndAssignments(db);

    const seniorAssignment = getAssignment(db, 'senior-engineer');
    expect(seniorAssignment).toBeDefined();
    expect(seniorAssignment?.backend).toBe('zcode');
    expect(seniorAssignment?.model_id).toBe('glm-5.2');

    const glmModel = getModel(db, 'glm-5.2');
    expect(glmModel).toBeDefined();
    expect(glmModel?.provider).toBe('zai');
    expect(glmModel?.price_in_usd_per_mtok).toBeNull();
    expect(glmModel?.price_out_usd_per_mtok).toBeNull();
  });

  it('Phase 1: seeds officer roster on existing DB containing only Phase 0 roster', () => {
    const db = openDbConnection(dbPath);
    // Simulate pre-existing DB where listModels > 0
    seedPhase1OfficerRoster(db);

    // The versioned v2 reseed (run at boot) moves the officer off the
    // un-provisioned Ollama backend onto Google Gemini flash-lite.
    const officerAssignment = getAssignment(db, 'task-intake-officer');
    expect(officerAssignment).toBeDefined();
    expect(officerAssignment?.backend).toBe('google');
    expect(officerAssignment?.model_id).toBe('gemini-3.1-flash-lite');

    const geminiModel = getModel(db, 'gemini-2.5-flash');
    expect(geminiModel).toBeDefined();
    expect(geminiModel?.provider).toBe('google');
    expect(geminiModel?.price_in_usd_per_mtok).toBeNull();

    // The Phase 1 Ollama model is still registered (fallback if the operator
    // later provisions Ollama), just no longer the officer's assignment.
    const ollamaModel = getModel(db, 'qwen2.5-coder');
    expect(ollamaModel).toBeDefined();
    expect(ollamaModel?.provider).toBe('ollama');
  });

  it('openDbConnection: automatically seeds officer roster when opening an existing Phase 0 database', () => {
    // 1. Boot DB and simulate Phase 0 state (remove Phase 1 meta flag & models)
    let db = openDbConnection(dbPath);
    db.run("DELETE FROM bureau_meta WHERE key = 'seed:phase1-officer-roster'");
    db.run("DELETE FROM bureau_assignments WHERE role = 'task-intake-officer'");
    db.run("DELETE FROM bureau_models WHERE id IN ('gemini-2.5-flash', 'qwen2.5-coder')");

    // Ensure Phase 0 model remains so listModels > 0
    expect(getModel(db, 'glm-5.2')).toBeDefined();
    expect(getAssignment(db, 'task-intake-officer')).toBeNull();

    // 2. Re-open DB via boot door (openDbConnection)
    closeDatabase();
    db = openDbConnection(dbPath);

    // 3. Assert Phase 1 officer roster and assignment are automatically seeded on boot
    const officerAssignment = getAssignment(db, 'task-intake-officer');
    expect(officerAssignment).toBeDefined();
    expect(officerAssignment?.backend).toBe('ollama');
    expect(officerAssignment?.model_id).toBe('qwen2.5-coder');

    const googleModel = getModel(db, 'gemini-2.5-flash');
    expect(googleModel).toBeDefined();
    expect(googleModel?.provider).toBe('google');
  });
});
