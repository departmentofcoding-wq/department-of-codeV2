import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase, closeDatabase } from './connection.ts';
import { applySchema, applyAddedColumns } from './schema.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('A1: Database Infrastructure', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-db-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('T7: Boot twice in a row against the same file without error (idempotent boot)', () => {
    const db1 = getDatabase(dbPath);
    expect(() => applySchema(db1)).not.toThrow();

    // Boot second time on same connection
    expect(() => applySchema(db1)).not.toThrow();

    // Close and reconnect to same file
    closeDatabase();
    const db2 = getDatabase(dbPath);
    expect(() => applySchema(db2)).not.toThrow();
  });

  it('applyAddedColumns idempotently adds new columns to existing table', () => {
    const db = getDatabase(dbPath);
    applySchema(db);

    // Apply new column
    applyAddedColumns(db, 'bureau_tasks', [
      { name: 'experimental_flag', definition: 'TEXT DEFAULT NULL' }
    ]);

    // Re-apply same column (idempotency check)
    expect(() => {
      applyAddedColumns(db, 'bureau_tasks', [
        { name: 'experimental_flag', definition: 'TEXT DEFAULT NULL' }
      ]);
    }).not.toThrow();

    // Verify column exists
    const stmt = db.prepare('PRAGMA table_info(bureau_tasks)');
    const columns = stmt.all() as Array<{ name: string }>;
    expect(columns.some(c => c.name === 'experimental_flag')).toBe(true);
  });
});
