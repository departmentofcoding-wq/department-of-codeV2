import { describe, it, expect } from 'vitest';
import { GhCliPrProvider } from '../../engine/delivery/gh_cli_pr_provider.ts';
import { FakePrProvider } from '../helpers/fake_pr_provider.ts';
import { setPrProviderOverride, getPrProvider, getPrProviderOverride } from '../../engine/contract/pr-seam.ts';

describe('Stream B Unit Tests: PR Seam & Providers', () => {
  it('FakePrProvider tracks pushes, PR creation, and idempotent merges', async () => {
    const fake = new FakePrProvider();
    setPrProviderOverride(fake);

    expect(getPrProvider()).toBe(fake);
    expect(getPrProviderOverride()).toBe(fake);

    await fake.pushBranch('bureau-wt-task-1');
    expect(fake.pushedBranches).toEqual(['bureau-wt-task-1']);

    const res = await fake.createPr({
      branch: 'bureau-wt-task-1',
      title: 'feat: test',
      body: 'test body',
      base: 'main'
    });
    expect(res.url).toContain('/pull/100');
    expect(res.number).toBe(100);

    await fake.mergePr(100);
    expect(fake.mergedPrs).toEqual([100]);

    // Idempotent re-merge
    await fake.mergePr(100);
    expect(fake.mergedPrs).toEqual([100]);

    setPrProviderOverride(null);
  });

  it('GhCliPrProvider fails loudly when commands fail', async () => {
    const provider = new GhCliPrProvider('/nonexistent/path');
    await expect(provider.pushBranch('test-branch')).rejects.toThrow(/PR_PROVIDER_EXEC_ERROR/);
  });
});
