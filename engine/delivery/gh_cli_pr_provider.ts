import { execFileSync } from 'node:child_process';
import type { CreatePrInput, CreatePrResult, PrProvider } from '../contract/types.ts';
import { getRepoRoot } from '../worktrees/manager.ts';
import { DeliveryError } from './types.ts';

export class GhCliPrProvider implements PrProvider {
  public readonly repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = getRepoRoot(repoRoot);
  }

  private runCommand(cmd: string, args: string[], cwd?: string): string {
    try {
      return execFileSync(cmd, args, {
        cwd: cwd ?? this.repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new DeliveryError(
        `[PR_PROVIDER_EXEC_ERROR] Command '${cmd} ${args.join(' ')}' failed: ${stderr}. Ensure '${cmd}' is installed and authenticated in environment.`,
        'PR_PROVIDER_EXEC_ERROR'
      );
    }
  }

  public async pushBranch(branch: string): Promise<void> {
    this.runCommand('git', ['push', 'origin', branch]);
  }

  public async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    const output = this.runCommand('gh', [
      'pr',
      'create',
      '--head', input.branch,
      '--base', input.base,
      '--title', input.title,
      '--body', input.body
    ]);

    const url = output.trim();
    const match = url.match(/\/pull\/(\d+)$/);
    const number = match ? parseInt(match[1], 10) : 0;

    return {
      url,
      number
    };
  }

  public async mergePr(number: number): Promise<void> {
    this.runCommand('gh', ['pr', 'merge', number.toString(), '--merge']);
  }
}
