import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { applySchema, applyBootMigrations } from './schema.ts';

let activeDatabase: DatabaseSync | null = null;
let activeDbPath: string | null = null;

export function getDatabase(customPath?: string): DatabaseSync {
  const targetPath = customPath || process.env.BUREAU_DB_PATH || path.join(process.cwd(), 'db', 'bureau.db');

  if (targetPath !== ':memory:' && activeDatabase && activeDbPath === targetPath) {
    return activeDatabase;
  }

  if (activeDatabase) {
    closeDatabase();
  }

  mkdirSync(path.dirname(path.resolve(targetPath)), { recursive: true });

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  // The boot door: schema and migrations are applied here so no caller can
  // open a database that is one migration behind. Both are idempotent, so
  // running them on every open is cheap and safe. First-boot model seeds are
  // applied one layer up, in the adapter's openDbConnection, which owns the
  // contract connection — this layer never rises above raw node:sqlite.
  applySchema(db);
  applyBootMigrations(db);

  activeDatabase = db;
  activeDbPath = targetPath;
  return db;
}

export function closeDatabase(): void {
  if (activeDatabase) {
    try {
      activeDatabase.close();
    } catch {
      // Ignore close errors on teardown
    }
    activeDatabase = null;
    activeDbPath = null;
  }
}
