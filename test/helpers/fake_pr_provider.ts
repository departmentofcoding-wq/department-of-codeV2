import type { CreatePrInput, CreatePrResult, PrProvider } from '../../engine/contract/types.ts';

export class FakePrProvider implements PrProvider {
  public pushedBranches: string[] = [];
  public createdPrs: Array<CreatePrInput & CreatePrResult> = [];
  public mergedPrs: number[] = [];

  public nextPrNumber = 100;
  public shouldFailPush = false;
  public shouldFailCreate = false;
  public shouldFailMerge = false;
  public failReason = 'FakePrProvider injected failure';

  public async pushBranch(branch: string, _cwd?: string): Promise<void> {
    if (this.shouldFailPush) {
      throw new Error(this.failReason);
    }
    this.pushedBranches.push(branch);
  }

  public async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    if (this.shouldFailCreate) {
      throw new Error(this.failReason);
    }
    const number = this.nextPrNumber++;
    const url = `https://github.com/bureau-fake/repo/pull/${number}`;
    const result = { url, number };
    this.createdPrs.push({ ...input, ...result });
    return result;
  }

  public async mergePr(number: number): Promise<void> {
    if (this.shouldFailMerge) {
      throw new Error(this.failReason);
    }
    // Idempotent re-merge: if already merged, do not throw
    if (!this.mergedPrs.includes(number)) {
      this.mergedPrs.push(number);
    }
  }
}
