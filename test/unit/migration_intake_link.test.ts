import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyBootMigrations, applySchema } from '../../engine/db/schema.ts';

describe('Migration & Schema Boot Door (Legacy DB test)', () => {
  it('migrates legacy database by adding intake_session_id column and creating unique index', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-migration-'));
    const dbPath = path.join(tmpDir, 'legacy.db');
    const db = new DatabaseSync(dbPath);

    // Create legacy table DDL (without intake_session_id)
    db.exec(`
      CREATE TABLE bureau_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        intent TEXT, spec TEXT, acceptance TEXT,
        verify_cmd TEXT, setup_cmd TEXT,
        state TEXT NOT NULL DEFAULT 'intake',
        verifier_exit_code INTEGER,
        approved_at TEXT, approved_by TEXT,
        merged_at TEXT, merged_by TEXT,
        priority INTEGER NOT NULL DEFAULT 1,
        work_uuid TEXT NOT NULL,
        work_title TEXT,
        plan_rounds INTEGER NOT NULL DEFAULT 0,
        verify_fixes INTEGER NOT NULL DEFAULT 0,
        cycles INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        pull_request_url TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);

    // Verify column intake_session_id does NOT exist yet
    const initialCols = db.prepare('PRAGMA table_info(bureau_tasks)').all() as Array<{ name: string }>;
    expect(initialCols.some((c) => c.name === 'intake_session_id')).toBe(false);

    // Run schema and boot migrations (the boot door)
    applySchema(db);
    applyBootMigrations(db);

    // Assert column now exists
    const migratedCols = db.prepare('PRAGMA table_info(bureau_tasks)').all() as Array<{ name: string }>;
    expect(migratedCols.some((c) => c.name === 'intake_session_id')).toBe(true);

    // Assert index enforcing unique intake_session_id works
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at, intake_session_id)
      VALUES ('t-1', 'Task 1', 'w-1', '${now}', '${now}', 'sess-100');
    `);

    // Duplicate non-null intake_session_id must fail
    expect(() => {
      db.exec(`
        INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at, intake_session_id)
        VALUES ('t-2', 'Task 2', 'w-2', '${now}', '${now}', 'sess-100');
      `);
    }).toThrow();

    // Multiple NULL intake_session_ids must succeed
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at, intake_session_id)
      VALUES ('t-3', 'Task 3', 'w-3', '${now}', '${now}', NULL);
    `);
    db.exec(`
      INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at, intake_session_id)
      VALUES ('t-4', 'Task 4', 'w-4', '${now}', '${now}', NULL);
    `);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
