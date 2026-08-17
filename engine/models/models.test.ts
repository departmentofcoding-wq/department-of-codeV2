import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDbConnection, closeDatabase } from '../db/index.ts';
import { seedModelsAndAssignments, getModel, getAssignment } from './index.ts';
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
});
