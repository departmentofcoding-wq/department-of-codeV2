/**
 * Junior provider seam: allows looking up provider-specific paths (such as the
 * junior's brain directory) and injecting mock implementations in tests.
 */
export interface JuniorProvider {
  /**
   * Return the provider's brain directory path for the given junior (e.g. 'A' | 'B'),
   * or null if this provider has no brain directory or is not configured.
   */
  brainDir?(junior?: string): string | null;
}

let juniorProviderOverride: JuniorProvider | null = null;
let defaultBrainResolver: ((junior?: string) => string | null) | null = null;

export function registerDefaultBrainResolver(resolver: (junior?: string) => string | null): void {
  defaultBrainResolver = resolver;
}

const defaultJuniorProvider: JuniorProvider = {
  brainDir(junior?: string): string | null {
    return defaultBrainResolver ? defaultBrainResolver(junior) : null;
  }
};

export function setJuniorProviderOverride(provider: JuniorProvider | null): void {
  juniorProviderOverride = provider;
}

export function setJuniorProvider(provider: JuniorProvider | null): void {
  juniorProviderOverride = provider;
}

export function getJuniorProviderOverride(): JuniorProvider | null {
  return juniorProviderOverride;
}

export function getJuniorProvider(): JuniorProvider {
  return juniorProviderOverride ?? defaultJuniorProvider;
}
