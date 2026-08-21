import type { DatabaseSync } from 'node:sqlite';

import type { DbConnection, Statement } from '../contract/index.ts';
import { listModels } from '../models/registry.ts';
import { seedModelsAndAssignments, seedPhase1OfficerRoster, seedGoogleRosterV2 } from '../models/seed.ts';
import { getDatabase, closeDatabase } from './connection.ts';

/**
 * The single adapter from node:sqlite's DatabaseSync to the contract's
 * DbConnection. Every caller — the runner, the future web board, and the
 * tests — goes through this, so there is exactly one place that knows how
 * parameters and transactions map onto the driver.
 *
 * Parameters accept both calling conventions: variadic (`run(sql, a, b)`)
 * and the single-array form (`run(sql, [a, b])`). Both are in active use.
 */

function flattenParams(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0];
  }
  return params;
}

function wrapStatement(stmt: ReturnType<DatabaseSync['prepare']>): Statement {
  return {
    run(...params: unknown[]) {
      const res = stmt.run(...(flattenParams(params) as any[]));
      return { changes: Number(res.changes), lastInsertRowid: res.lastInsertRowid };
    },
    get<T>(...params: unknown[]): T | undefined {
      return stmt.get(...(flattenParams(params) as any[])) as T | undefined;
    },
    all<T>(...params: unknown[]): T[] {
      return stmt.all(...(flattenParams(params) as any[])) as T[];
    }
  };
}

export function wrapDatabaseSync(sqlite: DatabaseSync): DbConnection & { close: () => void } {
  let inTransaction = false;

  return {
    prepare(sql: string): Statement {
      return wrapStatement(sqlite.prepare(sql));
    },
    run(sql: string, ...params: unknown[]) {
      const res = sqlite.prepare(sql).run(...(flattenParams(params) as any[]));
      return { changes: Number(res.changes), lastInsertRowid: res.lastInsertRowid };
    },
    get<T>(sql: string, ...params: unknown[]): T | undefined {
      return sqlite.prepare(sql).get(...(flattenParams(params) as any[])) as T | undefined;
    },
    all<T>(sql: string, ...params: unknown[]): T[] {
      return sqlite.prepare(sql).all(...(flattenParams(params) as any[])) as T[];
    },
    exec(sql: string): void {
      sqlite.exec(sql);
    },
    execTransaction<T>(fn: () => T): T {
      if (inTransaction) {
        return fn();
      }
      inTransaction = true;
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // Transaction already aborted; the original error is the story.
        }
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      sqlite.close();
    }
  };
}


/**
 * Open the department's database through the boot door (schema, migrations)
 * and return it as the contract connection. First-boot seeds run here, only
 * when the registry is empty: registerModel upserts, and re-seeding on every
 * open would stomp settings the operator changed by hand.
 */
export function openDbConnection(customPath?: string): DbConnection & { close: () => void } {
  const sqlite = getDatabase(customPath);
  const wrapped = wrapDatabaseSync(sqlite);
  if (listModels(wrapped).length === 0) {
    seedModelsAndAssignments(wrapped);
  }
  seedPhase1OfficerRoster(wrapped);
  seedGoogleRosterV2(wrapped);
  return {
    ...wrapped,
    close() {
      closeDatabase();
    }
  };
}
