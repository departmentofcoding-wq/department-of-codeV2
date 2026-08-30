import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CreatePrInput, CreatePrResult, PrProvider } from '../contract/types.ts';
import { getRepoRoot } from '../worktrees/manager.ts';
import { DeliveryError } from './types.ts';

/**
 * The gh/git CLI seam. Every command runs ASYNC on purpose: these subprocesses
 * take seconds (gh pr create ≈ 6s live), and a synchronous execFileSync here
 * froze the runner's event loop past the job-lease window — the 2026-08-28
 * duplicate-execution incident (journal #790–#812): the 5s lease expired
 * mid-`gh`, a second runner reaped + re-claimed the job, and both executed it.
 * While the loop is free, the runner's 1s heartbeat keeps the lease alive.
 */
const execFileAsync = promisify(execFile);

export class GhCliPrProvider implements PrProvider {
  public readonly repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = getRepoRoot(repoRoot);
  }

  private async runCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        cwd: cwd ?? this.repoRoot,
        encoding: 'utf8'
      });
      return stdout.trim();
    } catch (err: any) {
      const stderr = err?.stderr ? String(err.stderr) : err.message;
      throw new DeliveryError(
        `[PR_PROVIDER_EXEC_ERROR] Command '${cmd} ${args.join(' ')}' failed: ${stderr}. Ensure '${cmd}' is installed and authenticated in environment.`,
        'PR_PROVIDER_EXEC_ERROR'
      );
    }
  }

  public async pushBranch(branch: string, cwd?: string): Promise<void> {
    await this.runCommand('git', ['push', 'origin', branch], cwd);
  }

  public async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    const output = await this.runCommand('gh', [
      'pr',
      'create',
      '--head', input.branch,
      '--base', input.base,
      '--title', input.title,
      '--body', input.body
    ]);

    // gh pr create returns the PR URL (e.g., https://github.com/owner/repo/pull/123)
    const url = output.trim();
    const match = url.match(/\/pull\/(\d+)$/);
    const number = match ? parseInt(match[1], 10) : 0;

    return {
      url,
      number
    };
  }

  public async mergePr(number: number): Promise<void> {
    await this.runCommand('gh', ['pr', 'merge', number.toString(), '--merge']);
  }
}
