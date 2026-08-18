import type { LlmClient } from './types.ts';

let mockClientOverride: LlmClient | null = null;

export function setMockClientOverride(client: LlmClient | null): void {
  mockClientOverride = client;
}

export function getMockClientOverride(): LlmClient | null {
  return mockClientOverride;
}

export function clearMockClientOverride(): void {
  mockClientOverride = null;
}
