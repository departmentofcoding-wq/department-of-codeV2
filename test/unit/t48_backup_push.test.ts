import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupProvider } from '../../engine/contract/backup-seam.ts';
import { setBackupProviderOverride } from '../../engine/contract/backup-seam.ts';
import type { DbConnection, JobContext } from '../../engine/contract/types.ts';
import { openDbConnection } from '../../engine/db/adapter.ts';
import { BackupPushError, handleBackupPush } from '../../engine/durability/backup_push.ts';

class MockBackupProvider implements BackupProvider {
  public pushedRemotes: Array<{ remote?: string; branch?: string }> = [];
  public localTipValue: string = 'hash-local-100';
  public remoteTipValue: string = 'hash-local-100';

  public async getLocalTip(_branch?: string): Promise<string> {
    return this.localTipValue;
  }

  public async push(remote?: string, branch?: string): Promise<void> {
    this.pushedRemotes.push({ remote, branch });
  }

  public async getRemoteTip(_remote?: string, _branch?: string): Promise<string> {
    return this.remoteTipValue;
  }
}

describe('T48 — Backup Push Automation & Remote Tip Verification (Milestone B1)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t48-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDbConnection(dbPath);
  });

  afterEach(() => {
    setBackupProviderOverride(null);
    try {
      (db as any).close();
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore OS file lock
    }
  });

  it('T48: refuses to claim success on a remote-tip mismatch (fails closed with guardrail span)', async () => {
    const mockProvider = new MockBackupProvider();
    mockProvider.localTipValue = 'commit-local-aaa111';
    mockProvider.remoteTipValue = 'commit-remote-bbb222'; // Mismatch!
    setBackupProviderOverride(mockProvider);

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('task-t48-1', 'Test Task 1', 'needs-review', 'w-1', ?, ?)`,
      now, now
    );
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, created_at)
       VALUES ('job-t48-1', 'backup.push', 'task-t48-1', '{"target":"origin/main"}', 'running', ?)`,
      now
    );

    const ctx: JobContext = {
      db,
      job: {
        id: 'job-t48-1',
        kind: 'backup.push',
        task_id: 'task-t48-1',
        payload: JSON.stringify({ target: 'origin/main' }),
        state: 'running',
        attempts: 1,
        max_attempts: 3,
        run_after: now,
        lease_owner: null,
        lease_expires_at: null,
        reaped_count: 0,
        last_error: null,
        created_at: now,
        started_at: now,
        finished_at: null
      },
      payload: { target: 'origin/main' },
      signal: new AbortController().signal
    };

    await expect(handleBackupPush(ctx)).rejects.toThrow(BackupPushError);
    await expect(handleBackupPush(ctx)).rejects.toThrow(/Remote tip mismatch/);

    expect(mockProvider.pushedRemotes.length).toBeGreaterThan(0);
    expect(mockProvider.pushedRemotes[0]).toEqual({ remote: 'origin', branch: 'main' });

    // Verify guardrail span recorded in journal
    const spans = db.all<{ kind: string; detail_json: string; detail: string }>(
      'SELECT * FROM bureau_journal WHERE kind = ?',
      'guardrail'
    );
    expect(spans.length).toBeGreaterThan(0);

    const guardrailDetail = JSON.parse(spans[0].detail ?? spans[0].detail_json);
    expect(guardrailDetail.action).toBe('backup.push');
    expect(guardrailDetail.status).toBe('mismatch');
    expect(guardrailDetail.localTip).toBe('commit-local-aaa111');
    expect(guardrailDetail.remoteTip).toBe('commit-remote-bbb222');
  });

  it('T48: succeeds and journals system span when remote tip matches local tip', async () => {
    const mockProvider = new MockBackupProvider();
    mockProvider.localTipValue = 'commit-local-aaa111';
    mockProvider.remoteTipValue = 'commit-local-aaa111'; // Match!
    setBackupProviderOverride(mockProvider);

    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('task-t48-2', 'Test Task 2', 'needs-review', 'w-2', ?, ?)`,
      now, now
    );
    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, created_at)
       VALUES ('job-t48-2', 'backup.push', 'task-t48-2', '{"target":"origin/main"}', 'running', ?)`,
      now
    );

    const ctx: JobContext = {
      db,
      job: {
        id: 'job-t48-2',
        kind: 'backup.push',
        task_id: 'task-t48-2',
        payload: JSON.stringify({ target: 'origin/main' }),
        state: 'running',
        attempts: 1,
        max_attempts: 3,
        run_after: now,
        lease_owner: null,
        lease_expires_at: null,
        reaped_count: 0,
        last_error: null,
        created_at: now,
        started_at: now,
        finished_at: null
      },
      payload: { target: 'origin/main' },
      signal: new AbortController().signal
    };

    await expect(handleBackupPush(ctx)).resolves.toBeUndefined();

    // Verify system success span recorded in journal
    const spans = db.all<{ kind: string; detail_json: string; detail: string }>(
      'SELECT * FROM bureau_journal WHERE kind = ?',
      'system'
    );
    expect(spans.length).toBeGreaterThan(0);

    const successDetail = JSON.parse(spans[0].detail ?? spans[0].detail_json);
    expect(successDetail.action).toBe('backup.push');
    expect(successDetail.status).toBe('success');
    expect(successDetail.localTip).toBe('commit-local-aaa111');
    expect(successDetail.remoteTip).toBe('commit-local-aaa111');
  });
});
