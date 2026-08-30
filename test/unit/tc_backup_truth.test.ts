import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import { setBackupProviderOverride } from '../../engine/contract/backup-seam.ts';
import { ExecGitBackupProvider } from '../../engine/durability/git_backup_provider.ts';
import { handleBackupPush } from '../../engine/durability/backup_push.ts';
import type { DbConnection, JobContext } from '../../engine/contract/types.ts';

/**
 * The post-PR-merge backup truth (the 2026-08-26→28 scar: four dead
 * backup.push jobs). pr.merge merges PRs ON GitHub, so origin/main is AHEAD
 * of local when the chained backup runs; the old "push local main" died
 * `! [rejected] (fetch first)` on every delivery. The handler now fetches,
 * fast-forwards local, and PROVES containment — all against REAL git repos
 * and a REAL bare remote, no mocks (temp paths, cleaned up; no network).
 */

function git(cwd: string, cmd: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, encoding: 'utf8' }).trim();
}

let dir: string;
let db: DbConnection & { close: () => void };
let originPath: string;
let localPath: string;
let otherPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-truth-'));
  db = createRealSqliteDb(path.join(dir, 'bureau.db'));

  originPath = path.join(dir, 'origin.git');
  localPath = path.join(dir, 'local');
  otherPath = path.join(dir, 'other');

  // Seed: empty bare origin + a local clone whose main becomes the branch head.
  execSync(`git init -q --bare "${originPath}"`);
  execSync(`git clone -q "${originPath}" "${localPath}"`);
  git(localPath, 'checkout -q -b main');
  git(localPath, 'commit -q --allow-empty -m init');
  git(localPath, 'push -q -u origin main');
  // A second clone plays "the GitHub server side": commits landing on origin
  // from somewhere OTHER than the local repo (exactly what a PR merge is).
  execSync(`git clone -q -b main "${originPath}" "${otherPath}"`);
});

afterEach(() => {
  setBackupProviderOverride(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function runHandler(payload: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const ctx: JobContext = {
    db,
    job: {
      id: 'job-bt-1',
      kind: 'backup.push',
      task_id: null,
      payload: JSON.stringify(payload),
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
    payload,
    signal: new AbortController().signal
  };
  return handleBackupPush(ctx);
}

function lastSpan(): { kind: string; detail: string } | undefined {
  return db.get<{ kind: string; detail: string }>(
    `SELECT kind, detail FROM bureau_journal WHERE detail LIKE '%backup.push%' ORDER BY id DESC LIMIT 1`
  );
}

describe('backup truth after a server-side PR merge (remote ahead)', () => {
  it('records containment proof instead of pushing, and fast-forwards local main to the remote', async () => {
    // "GitHub" merges the PR: the other clone advances origin/main.
    git(otherPath, 'commit -q --allow-empty -m "server-side merge"');
    const serverTip = git(otherPath, 'rev-parse HEAD');
    git(otherPath, 'push -q origin main');

    const provider = new ExecGitBackupProvider(localPath);
    setBackupProviderOverride(provider);

    await runHandler({ target: 'origin/main', commit: serverTip });

    // Proof span recorded, no push attempted (and none needed).
    const span = lastSpan();
    expect(span?.kind).toBe('system');
    expect(JSON.parse(span!.detail)).toMatchObject({ action: 'backup.push', status: 'already_on_remote', commit: serverTip });

    // Local main reconciled: fast-forwarded to the server tip — local/origin
    // no longer diverge after a delivery.
    const localTip = git(localPath, 'rev-parse main');
    expect(localTip).toBe(serverTip);
  });

  it('the exit-1 containment answer reads as FALSE (not a thrown failure)', async () => {
    git(otherPath, 'commit -q --allow-empty -m "server-side merge"');
    git(otherPath, 'push -q origin main');
    // A commit that exists locally but was never pushed anywhere.
    git(localPath, 'commit -q --allow-empty -m "local-only, not on remote"');
    const unpushed = git(localPath, 'rev-parse HEAD');

    const provider = new ExecGitBackupProvider(localPath);
    // remoteContains reads remote-TRACKING refs — current only after fetch
    // (the handler always fetches first; this mirrors its contract).
    await provider.fetch('origin');
    await expect(provider.remoteContains('origin', 'main', unpushed)).resolves.toBe(false);
    // Sanity: the server tip IS contained.
    const serverTip = git(otherPath, 'rev-parse HEAD');
    await expect(provider.remoteContains('origin', 'main', serverTip)).resolves.toBe(true);
  });
});

describe('backup truth when local is genuinely ahead (the legacy case still works)', () => {
  it('pushes local main and verifies the readback', async () => {
    git(localPath, 'commit -q --allow-empty -m "local engine-dev merge"');
    const localTip = git(localPath, 'rev-parse HEAD');

    setBackupProviderOverride(new ExecGitBackupProvider(localPath));

    await runHandler({ target: 'origin/main', commit: localTip });

    const remoteTip = git(localPath, `rev-parse origin/main`);
    // The push path ran (remote advanced to the local tip)...
    expect(remoteTip).toBe(localTip);
    // ...and the success span is the classic readback proof.
    const span = lastSpan();
    expect(JSON.parse(span!.detail)).toMatchObject({
      action: 'backup.push',
      status: 'success',
      localTip,
      remoteTip: localTip
    });
  });
});

describe('providers without the optional truth methods (back-compat)', () => {
  it('a minimal push/getTips provider still completes via the legacy path', async () => {
    git(localPath, 'commit -q --allow-empty -m "local ahead, fake provider"');
    const localTip = git(localPath, 'rev-parse HEAD');
    setBackupProviderOverride({
      getLocalTip: async () => localTip,
      push: async () => {},
      getRemoteTip: async () => localTip
    });
    await expect(runHandler({ target: 'origin/main', commit: localTip })).resolves.toBeUndefined();
    expect(JSON.parse(lastSpan()!.detail)).toMatchObject({ status: 'success' });
  });
});
