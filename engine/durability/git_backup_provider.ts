import { execFileSync } from 'node:child_process';
import type { BackupProvider } from '../contract/backup-seam.ts';

export class ExecGitBackupProvider implements BackupProvider {
  public readonly repoRoot: string;

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
  }

  private runCommand(cmd: string, args: string[]): string {
    try {
      return execFileSync(cmd, args, {
        cwd: this.repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new Error(`Git backup command '${cmd} ${args.join(' ')}' failed: ${stderr}`);
    }
  }

  public async getLocalTip(branch: string = 'HEAD'): Promise<string> {
    const raw = this.runCommand('git', ['rev-parse', branch]);
    return raw.trim().split(/\s+/)[0];
  }

  public async push(remote: string = 'origin', branch: string = 'main'): Promise<void> {
    this.runCommand('git', ['push', remote, branch]);
  }

  public async getRemoteTip(remote: string = 'origin', branch: string = 'main'): Promise<string> {
    const raw = this.runCommand('git', ['ls-remote', remote, `refs/heads/${branch}`]);
    const firstToken = raw.trim().split(/\s+/)[0];
    if (!firstToken) {
      throw new Error(`Could not parse remote tip for ${remote}/${branch} from output: '${raw}'`);
    }
    return firstToken;
  }
}
