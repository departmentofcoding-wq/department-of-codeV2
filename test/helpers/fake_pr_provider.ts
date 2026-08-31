import type { CreatePrInput, CreatePrResult, PrProvider } from '../../engine/contract/types.ts';

export class FakePrProvider implements PrProvider {
  public pushedBranches: string[] = [];
  public createdPrs: Array<CreatePrInput & CreatePrResult> = [];
  public mergedPrs: number[] = [];

  // The cwd each seam call received, so tests can prove `gh`/`git` run in the
  // task's own project worktree, not the dept repo (N8).
  public pushCwds: Array<string | undefined> = [];
  public createCwds: Array<string | undefined> = [];
  public mergeCwds: Array<string | undefined> = [];

  public nextPrNumber = 100;
  public shouldFailPush = false;
  public shouldFailCreate = false;
  public shouldFailMerge = false;
  public failReason = 'FakePrProvider injected failure';

  public async pushBranch(branch: string, cwd?: string): Promise<void> {
    if (this.shouldFailPush) {
      throw new Error(this.failReason);
    }
    this.pushedBranches.push(branch);
    this.pushCwds.push(cwd);
  }

  public async createPr(input: CreatePrInput, cwd?: string): Promise<CreatePrResult> {
    if (this.shouldFailCreate) {
      throw new Error(this.failReason);
    }
    const number = this.nextPrNumber++;
    const url = `https://github.com/bureau-fake/repo/pull/${number}`;
    const result = { url, number };
    this.createdPrs.push({ ...input, ...result });
    this.createCwds.push(cwd);
    return result;
  }

  public async mergePr(number: number, cwd?: string): Promise<void> {
    if (this.shouldFailMerge) {
      throw new Error(this.failReason);
    }
    this.mergeCwds.push(cwd);
    // Idempotent re-merge: if already merged, do not throw
    if (!this.mergedPrs.includes(number)) {
      this.mergedPrs.push(number);
    }
  }
}
