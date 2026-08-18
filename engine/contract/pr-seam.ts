import type { PrProvider } from './types.ts';

let prProviderOverride: PrProvider | null = null;

export function setPrProviderOverride(provider: PrProvider | null): void {
  prProviderOverride = provider;
}

export function getPrProvider(): PrProvider {
  if (!prProviderOverride) {
    throw new Error('PR provider has not been initialized or registered.');
  }
  return prProviderOverride;
}

export function getPrProviderOverride(): PrProvider | null {
  return prProviderOverride;
}
