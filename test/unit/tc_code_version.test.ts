import { describe, it, expect } from 'vitest';
import { isCodeStale, getGitHeadSha } from '../../engine/harness/code-version.ts';

/** F3 — stale-runner detection core. */
describe('isCodeStale', () => {
  it('is true only when both shas are known AND differ', () => {
    expect(isCodeStale('aaaaaaa', 'bbbbbbb')).toBe(true);
    expect(isCodeStale('aaaaaaa', 'aaaaaaa')).toBe(false);
  });
  it('never trips on a missing sha (unknown git info is not "stale")', () => {
    expect(isCodeStale(null, 'bbbbbbb')).toBe(false);
    expect(isCodeStale('aaaaaaa', null)).toBe(false);
    expect(isCodeStale(null, null)).toBe(false);
  });
  it('getGitHeadSha returns a sha in a real repo, or null (never throws)', () => {
    const sha = getGitHeadSha();
    // In this repo it should resolve; the contract is "sha-or-null, never throw".
    expect(sha === null || /^[0-9a-f]{7,40}$/i.test(sha)).toBe(true);
  });
});
