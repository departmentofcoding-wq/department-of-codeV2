import type { IdeDriver } from './types.ts';

let ideDriverOverride: IdeDriver | null = null;

export function setIdeDriverOverride(driver: IdeDriver | null): void {
  ideDriverOverride = driver;
}

export function getIdeDriver(): IdeDriver {
  if (!ideDriverOverride) {
    throw new Error('IDE driver has not been initialized or registered.');
  }
  return ideDriverOverride;
}

export function getIdeDriverOverride(): IdeDriver | null {
  return ideDriverOverride;
}
