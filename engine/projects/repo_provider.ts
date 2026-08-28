import { execFileSync } from 'node:child_process';
import type { CreateRemoteOptions, CreateRemoteResult, RepoProvider } from '../contract/types.ts';

export class ProvisionError extends Error {
  public readonly code: string;
  constructor(message: string, code: string = 'PROVISION_ERROR') {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
  }
}

export class GhCliRepoProvider implements RepoProvider {
  private runCommand(cmd: string, args: string[], cwd?: string): string {
    try {
      return execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString() : err.message;
      throw new ProvisionError(
        `Command '${cmd} ${args.join(' ')}' failed: ${stderr}. Ensure '${cmd}' is installed and authenticated.`,
        'REPO_PROVIDER_EXEC_ERROR'
      );
    }
  }

  public async createRemote(opts: CreateRemoteOptions): Promise<CreateRemoteResult> {
    const fullRepo = `${opts.owner}/${opts.name}`;
    const visibilityFlag = opts.visibility === 'public' ? '--public' : '--private';
    const args = [
      'repo',
      'create',
      fullRepo,
      visibilityFlag,
      '--source', opts.sourcePath,
      '--remote', 'origin',
      '--push'
    ];
    if (opts.description) {
      args.push('--description', opts.description);
    }

    this.runCommand('gh', args, opts.sourcePath);

    return {
      url: `https://github.com/${fullRepo}`
    };
  }

  public async getAuthStatus(): Promise<{ authenticated: boolean; login: string | null; scopes: string[] }> {
    try {
      const output = execFileSync('gh', ['auth', 'status'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return this.parseAuthStatus(output);
    } catch (err: any) {
      const combined = [
        err?.stdout ? err.stdout.toString() : '',
        err?.stderr ? err.stderr.toString() : '',
        err?.message || ''
      ].join('\n');
      return this.parseAuthStatus(combined);
    }
  }

  private parseAuthStatus(raw: string): { authenticated: boolean; login: string | null; scopes: string[] } {
    if (!raw || raw.includes('You are not logged into any GitHub hosts')) {
      return { authenticated: false, login: null, scopes: [] };
    }

    const accountMatch = raw.match(/account\s+([a-zA-Z0-9_-]+)/i) || raw.match(/Logged in to [^\s]+\s+(?:account|as)\s+([a-zA-Z0-9_-]+)/i);
    const login = accountMatch ? accountMatch[1] : null;

    const scopesMatch = raw.match(/Token scopes:\s*(.*)/i);
    let scopes: string[] = [];
    if (scopesMatch && scopesMatch[1]) {
      const scopesLine = scopesMatch[1].split('\n')[0].trim();
      scopes = scopesLine
        .split(',')
        .map(s => s.replace(/['"`]/g, '').trim())
        .filter(Boolean);
    }

    const authenticated = Boolean(login) && !raw.includes('Authentication failed');

    return {
      authenticated,
      login: authenticated ? login : null,
      scopes: authenticated ? scopes : []
    };
  }
}

let repoProviderOverride: RepoProvider | null = null;

export function setRepoProviderOverride(provider: RepoProvider | null): void {
  repoProviderOverride = provider;
}

export function setRepoProvider(provider: RepoProvider | null): void {
  repoProviderOverride = provider;
}

export function resetRepoProvider(): void {
  repoProviderOverride = null;
}

export function getRepoProvider(): RepoProvider {
  if (repoProviderOverride) {
    return repoProviderOverride;
  }
  return new GhCliRepoProvider();
}
