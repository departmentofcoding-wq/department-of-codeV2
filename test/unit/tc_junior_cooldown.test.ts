import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import type { DbConnection } from '../../engine/contract/types.ts';
import {
  isJuniorHealthy,
  setJuniorUnhealthy,
  clearJuniorUnhealthy
} from '../../engine/flow/junior-health.ts';
import { JUNIOR_HEALTH_META_KEYS } from '../../engine/contract/constants.ts';

describe('Unit: Junior Cooldown & bureau_meta State Management', () => {
  let db: DbConnection & { close: () => void };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-cooldown-'));
    db = createRealSqliteDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initially returns isJuniorHealthy: true for unflagged junior', () => {
    expect(isJuniorHealthy(db, 'A')).toBe(true);
    expect(isJuniorHealthy(db, 'B')).toBe(true);
  });

  it('setJuniorUnhealthy writes expiration timestamp to bureau_meta and marks junior unhealthy', () => {
    setJuniorUnhealthy(db, 'A', 60000, 'CDP timeout error');

    expect(isJuniorHealthy(db, 'A')).toBe(false);
    expect(isJuniorHealthy(db, 'B')).toBe(true);

    const row = db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      `${JUNIOR_HEALTH_META_KEYS.COOLDOWN_PREFIX}A`
    );
    expect(row).toBeTruthy();
    expect(new Date(row!.value).getTime()).toBeGreaterThan(Date.now());
  });

  it('multi-process coherence: reads directly reflect updated bureau_meta across connections', () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const db2 = createRealSqliteDb(dbPath);

    try {
      expect(isJuniorHealthy(db2, 'B')).toBe(true);

      // Process 1 sets cooldown
      setJuniorUnhealthy(db, 'B', 30000);

      // Process 2 immediately sees junior is unhealthy without stale in-memory cache
      expect(isJuniorHealthy(db2, 'B')).toBe(false);

      // Process 1 clears cooldown
      clearJuniorUnhealthy(db, 'B');

      // Process 2 immediately sees junior is healthy again
      expect(isJuniorHealthy(db2, 'B')).toBe(true);
    } finally {
      db2.close();
    }
  });

  it('clearJuniorUnhealthy clears bureau_meta and restores healthy status', () => {
    setJuniorUnhealthy(db, 'A', 60000);
    expect(isJuniorHealthy(db, 'A')).toBe(false);

    clearJuniorUnhealthy(db, 'A');
    expect(isJuniorHealthy(db, 'A')).toBe(true);

    const row = db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      `${JUNIOR_HEALTH_META_KEYS.COOLDOWN_PREFIX}A`
    );
    expect(row).toBeUndefined();
  });

  it('expired cooldown timestamp in bureau_meta automatically evaluates as healthy', () => {
    // Write past timestamp (10 seconds ago)
    const past = new Date(Date.now() - 10000).toISOString();
    db.run(
      'INSERT INTO bureau_meta (key, value) VALUES (?, ?)',
      `${JUNIOR_HEALTH_META_KEYS.COOLDOWN_PREFIX}A`,
      past
    );

    expect(isJuniorHealthy(db, 'A')).toBe(true);
  });
});
