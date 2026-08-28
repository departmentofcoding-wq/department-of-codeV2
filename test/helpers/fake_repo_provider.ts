import type { CreateRemoteOptions, CreateRemoteResult, GithubAuthStatusDTO, RepoProvider } from '../../engine/contract/types.ts';

export class FakeRepoProvider implements RepoProvider {
  public createdRepos: Array<CreateRemoteOptions & CreateRemoteResult> = [];
  public shouldFailCreate = false;
  public failReason = 'FakeRepoProvider injected remote creation failure';
  public authStatus: GithubAuthStatusDTO = {
    authenticated: true,
    login: 'bureau-operator',
    scopes: ['repo', 'read:org']
  };

  public async createRemote(opts: CreateRemoteOptions): Promise<CreateRemoteResult> {
    if (this.shouldFailCreate) {
      throw new Error(this.failReason);
    }
    const url = `https://github.com/${opts.owner}/${opts.name}`;
    const result: CreateRemoteResult = { url };
    this.createdRepos.push({ ...opts, ...result });
    return result;
  }

  public async getAuthStatus(): Promise<GithubAuthStatusDTO> {
    return { ...this.authStatus };
  }
}

