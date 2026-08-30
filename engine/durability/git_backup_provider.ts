import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackupProvider } from '../contract/backup-seam.ts';

/**
 * Commands run ASYNC deliberately: `git push` is network-bound and takes
 * seconds. The synchronous version froze the runner's event loop past the
 * job-lease window, so a co-running runner reaped + re-claimed the backup job
 * mid-push (duplicate execution; incident record in GhCliPrProvider). While
 * the loop is free the runner's heartbeat keeps the lease alive.
 */
const execFileAsync = promisify(execFile);

export class ExecGitBackupProvider implements BackupProvider {
  public readonly repoRoot: string;

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot;
  }

  private async runCommand(cmd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        cwd: this.repoRoot,
        encoding: 'utf8'
      });
      return stdout.trim();
    } catch (err: any) {
      const stderr = err?.stderr ? String(err.stderr) : err.message;
      throw new Error(`Git backup command '${cmd} ${args.join(' ')}' failed: ${stderr}`);
    }
  }

  public async getLocalTip(branch: string = 'HEAD'): Promise<string> {
    const raw = await this.runCommand('git', ['rev-parse', branch]);
    return raw.trim().split(/\s+/)[0];
  }

  public async push(remote: string = 'origin', branch: string = 'main'): Promise<void> {
    await this.runCommand('git', ['push', remote, branch]);
  }

  public async getRemoteTip(remote: string = 'origin', branch: string = 'main'): Promise<string> {
    const raw = await this.runCommand('git', ['ls-remote', remote, `refs/heads/${branch}`]);
    const firstToken = raw.trim().split(/\s+/)[0];
    if (!firstToken) {
      throw new Error(`Could not parse remote tip for ${remote}/${branch} from output: '${raw}'`);
    }
    return firstToken;
  }
}
