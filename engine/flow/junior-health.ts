import type { DbConnection } from '../contract/types.ts';
import {
  DEFAULT_JUNIOR_COOLDOWN_MS,
  JUNIOR_HEALTH_META_KEYS
} from '../contract/constants.ts';

/**
 * Returns true if the junior is healthy (no active cooldown in bureau_meta).
 * Read-through check directly against bureau_meta ensures multi-process coherence
 * between runner and queue manager without stale in-memory masking.
 */
export function isJuniorHealthy(db: DbConnection, junior: string): boolean {
  const key = `${JUNIOR_HEALTH_META_KEYS.COOLDOWN_PREFIX}${junior}`;
  const row = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', key);
  if (!row || !row.value) return true;

  const expiryMs = new Date(row.value).getTime();
  if (Number.isNaN(expiryMs)) return true;

  return expiryMs <= Date.now();
}

/**
 * Transactionally marks a junior unhealthy by writing an expiration timestamp to bureau_meta.
 */
export function setJuniorUnhealthy(
  db: DbConnection,
  junior: string,
  cooldownMs: number = DEFAULT_JUNIOR_COOLDOWN_MS,
  _reason?: string
): void {
  const key = `${JUNIOR_HEALTH_META_KEYS.COOLDOWN_PREFIX}${junior}`;
  const expiry = new Date(Date.now() + cooldownMs).toISOString();
  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    expiry
  );
}

/**
 * Transactionally clears the unhealthy cooldown flag for a junior in bureau_meta.
 */
export function clearJuniorUnhealthy(db: DbConnection, junior: string): void {
  const key = `${JUNIOR_HEALTH_META_KEYS.COOLDOWN_PREFIX}${junior}`;
  db.run('DELETE FROM bureau_meta WHERE key = ?', key);
}
