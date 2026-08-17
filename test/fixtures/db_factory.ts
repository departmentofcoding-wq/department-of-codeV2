import type { DbConnection } from '../../engine/contract/index.ts';
import { getDatabase, openDbConnection, wrapDatabaseSync } from '../../engine/db/index.ts';

export interface TestDbInstance {
  db: DbConnection;
  cleanup: () => void;
}

/**
 * Real SQLite DbConnection implementation delegating to the engine's boot door
 * (applySchema + wrapDatabaseSync) for fresh test databases.
 */
export function createRealSqliteDb(dbPath: string): DbConnection & { close: () => void } {
  return openDbConnection(dbPath);
}

/**
 * In-Memory DbConnection Fake delegating to an in-memory DatabaseSync via the boot door.
 */
export function createFakeDb(): DbConnection & { close: () => void } {
  const sqlite = getDatabase(':memory:');
  return wrapDatabaseSync(sqlite);
}
