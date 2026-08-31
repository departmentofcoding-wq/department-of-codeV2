import path from 'node:path';
import { ExecGitBackupProvider } from '../durability/git_backup_provider.ts';

export interface BackupProvider {
  push(remote?: string, branch?: string): Promise<void>;
  getRemoteTip(remote?: string, branch?: string): Promise<string>;
  getLocalTip(branch?: string): Promise<string>;

  /**
   * Post-PR-merge truth sync (all optional so existing fakes stay valid; the
   * handler feature-detects and falls back to the push+readback path).
   *
   * pr.merge merges PRs ON GitHub — origin/main advances while local main
   * stays behind, and the old "push local main" backup then died on
   * `! [rejected] (fetch first)` on every single delivery (2026-08-26→28,
   * four dead backup.push jobs). These methods let the handler instead FETCH,
   * reconcile local, and VERIFY the merge commit is already on the remote.
   */
  /** Update remote-tracking refs (`git fetch <remote>`). */
  fetch?(remote?: string): Promise<void>;
  /** Is `commit` an ancestor of `<remote>/<branch>` (exit-code proof)? */
  remoteContains?(remote: string, branch: string, commit: string): Promise<boolean>;
  /** Fast-forward the local branch to `<remote>/<branch>` (fails if diverged). */
  fastForwardLocal?(remote: string, branch: string): Promise<void>;
}

let backupProviderOverride: BackupProvider | null = null;

export function setBackupProviderOverride(provider: BackupProvider | null): void {
  backupProviderOverride = provider;
}

export function getBackupProviderOverride(): BackupProvider | null {
  return backupProviderOverride;
}

export function getBackupProvider(repoRoot?: string): BackupProvider {
  if (backupProviderOverride) {
    return backupProviderOverride;
  }
  // `repoRoot` targets the git commands at a specific repository. The backup
  // for a task in a non-dept project must fetch/reconcile/verify against THAT
  // project's repo, not the dept repo (N9) — the caller resolves it from
  // `bureau_projects.path_to_repo`. When omitted, default to the engine source
  // tree's own root (this file lives at <repoRoot>/engine/contract/), NOT
  // process.cwd() — the runner/console can be launched from anywhere, and a
  // stray cwd made every git command in the default backup provider target the
  // wrong repository.
  return new ExecGitBackupProvider(repoRoot ?? path.resolve(import.meta.dirname, '../..'));
}
