import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { BackupProvider, BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { openDbConnection, closeDatabase } from '../../engine/db/index.ts';
import { setBackupProviderOverride } from '../../engine/contract/backup-seam.ts';
import { ExecGitBackupProvider } from '../../engine/durability/git_backup_provider.ts';
import { handleBackupPush, BackupPushError } from '../../engine/durability/backup_push.ts';

/**
 * T46 — delivery backup against a REAL throwaway remote (C1).
 *
 * pr.create/pr.merge are covered against fakes (t43/t44); this exercises the
 * final durability hop against a genuine bare git remote and proves the
 * anti-false-claim readback (`backup_push.ts`): after pushing, the REMOTE tip is
 * read back and compared to the local tip. A push that reports success but does
 * not actually land the commit is caught as a mismatch guardrail — the exact
 * failure the check exists for.
 */
describe('T46: backup.push against a real bare remote — readback both ways', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    setBackupProviderOverride(null);
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  /** A working repo wired to a bare 'origin', returning paths + a DB for journaling. */
  function setup(): { work: string; bare: string; db: DbConnection } {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t46-'));
    const bare = path.join(tempDir, 'remote.git');
    const work = path.join(tempDir, 'work');
    const dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(bare, { recursive: true });
    git(['init', '--bare'], bare);

    fs.mkdirSync(work, { recursive: true });
    git(['init'], work);
    git(['config', 'user.name', 'Bureau'], work);
    git(['config', 'user.email', 'bureau@local'], work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'first'], work);
    git(['branch', '-M', 'main'], work);
    git(['remote', 'add', 'origin', bare], work);

    const db = openDbConnection(dbPath);
    // The backup span references task_id 't46'; seed the row so the journal FK holds.
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('t46', 'T46 backup', 'queued', 'wuuid-46', ?, ?)`,
      now, now
    );
    return { work, bare, db };
  }

  function ctxFor(db: DbConnection) {
    return { db, job: { id: 'job-46', task_id: 't46', kind: 'backup.push' }, payload: { target: 'origin/main' } } as any;
  }

  it('success: pushes to the bare remote and the readback matches', async () => {
    const { work, bare, db } = setup();
    setBackupProviderOverride(new ExecGitBackupProvider(work));

    await handleBackupPush(ctxFor(db));

    // The bare remote really advanced to the local tip.
    const localTip = git(['rev-parse', 'main'], work);
    const remoteTip = git(['ls-remote', bare, 'refs/heads/main'], bare).split(/\s+/)[0];
    expect(remoteTip).toBe(localTip);

    const success = db.all<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%\"action\":\"backup.push\"%' AND detail LIKE '%success%'"
    );
    expect(success.length).toBe(1);
  });

  it('mismatch: a push that did not land is caught by the readback (guardrail + throw)', async () => {
    const { work, bare, db } = setup();

    // Establish the remote once (real push), then add a NEW local commit so the
    // local tip is ahead of the remote.
    const real = new ExecGitBackupProvider(work);
    await real.push('origin', 'main');
    fs.writeFileSync(path.join(work, 'b.txt'), 'two\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'second (never lands)'], work);

    // A provider that reads the REAL local/remote tips but whose push silently
    // does nothing — simulating a push that reported success without landing.
    const noLandProvider: BackupProvider = {
      getLocalTip: (b) => real.getLocalTip(b),
      getRemoteTip: (r, b) => real.getRemoteTip(r, b),
      push: async () => {
        /* reports success but does not update the remote */
      }
    };
    setBackupProviderOverride(noLandProvider);

    await expect(handleBackupPush(ctxFor(db))).rejects.toThrow(BackupPushError);

    // The remote is genuinely behind the local tip, and the mismatch is journaled.
    const localTip = git(['rev-parse', 'main'], work);
    const remoteTip = git(['ls-remote', bare, 'refs/heads/main'], bare).split(/\s+/)[0];
    expect(remoteTip).not.toBe(localTip);

    const mismatch = db.all<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%\"action\":\"backup.push\"%' AND detail LIKE '%mismatch%'"
    );
    expect(mismatch.length).toBe(1);
  });
});
