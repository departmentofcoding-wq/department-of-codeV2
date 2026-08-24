import { ExecGitBackupProvider } from '../durability/git_backup_provider.ts';

export interface BackupProvider {
  push(remote?: string, branch?: string): Promise<void>;
  getRemoteTip(remote?: string, branch?: string): Promise<string>;
  getLocalTip(branch?: string): Promise<string>;
}

let backupProviderOverride: BackupProvider | null = null;

export function setBackupProviderOverride(provider: BackupProvider | null): void {
  backupProviderOverride = provider;
}

export function getBackupProviderOverride(): BackupProvider | null {
  return backupProviderOverride;
}

export function getBackupProvider(): BackupProvider {
  if (backupProviderOverride) {
    return backupProviderOverride;
  }
  return new ExecGitBackupProvider();
}
