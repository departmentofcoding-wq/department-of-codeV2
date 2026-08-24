import { afterEach, describe, expect, it } from 'vitest';
import {
  getBackupProvider,
  setBackupProviderOverride
} from '../../engine/contract/backup-seam.ts';

describe('backup-seam: real provider resolution (regression)', () => {
  afterEach(() => setBackupProviderOverride(null));

  it('getBackupProvider() resolves the real ExecGitBackupProvider without throwing', () => {
    // Regression: the seam used require() in an ES module, so every backup.push
    // job died with "require is not defined" — the department had zero working
    // backups. A top-level import fixes it; instantiation must now succeed.
    let provider: ReturnType<typeof getBackupProvider> | undefined;
    expect(() => {
      provider = getBackupProvider();
    }).not.toThrow();
    expect(provider).toBeDefined();
    expect(typeof provider!.push).toBe('function');
    expect(typeof provider!.getRemoteTip).toBe('function');
    expect(typeof provider!.getLocalTip).toBe('function');
  });

  it('honors a test override', () => {
    const fake = {
      push: async () => {},
      getRemoteTip: async () => 'tip',
      getLocalTip: async () => 'tip'
    };
    setBackupProviderOverride(fake);
    expect(getBackupProvider()).toBe(fake);
  });
});
