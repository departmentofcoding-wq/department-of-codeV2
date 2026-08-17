import { DatabaseSync } from 'node:sqlite';

import { applySchema, wrapDatabaseSync } from '../../engine/db/index.ts';
import type { DbConnection } from '../../engine/contract/index.ts';

/**
 * Test connection factory. Delegates entirely to the engine: the schema is
 * the engine's schema (no duplicated DDL to drift), and the adapter is the
 * engine's adapter. The "fake" is real in-memory SQLite — the most honest
 * fake possible, since it enforces true atomicity.
 */

export function createRealSqliteDb(dbPath: string): DbConnection & { close: () => void } {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  applySchema(sqlite);
  return wrapDatabaseSync(sqlite);
}

export function createFakeDb(): DbConnection & { close: () => void } {
  return createRealSqliteDb(':memory:');
}
