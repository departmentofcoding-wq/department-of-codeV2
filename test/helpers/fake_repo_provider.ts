import type { CreateRemoteOptions, CreateRemoteResult, RepoProvider } from '../../engine/contract/types.ts';

export class FakeRepoProvider implements RepoProvider {
  public createdRepos: Array<CreateRemoteOptions & CreateRemoteResult> = [];
  public shouldFailCreate = false;
  public failReason = 'FakeRepoProvider injected remote creation failure';

  public async createRemote(opts: CreateRemoteOptions): Promise<CreateRemoteResult> {
    if (this.shouldFailCreate) {
      throw new Error(this.failReason);
    }
    const url = `https://github.com/${opts.owner}/${opts.name}`;
    const result: CreateRemoteResult = { url };
    this.createdRepos.push({ ...opts, ...result });
    return result;
  }
}
