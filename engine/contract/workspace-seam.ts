import type { WorkspaceProvider } from './types.ts';

let workspaceProviderOverride: WorkspaceProvider | null = null;

export function setWorkspaceProvider(provider: WorkspaceProvider | null): void {
  workspaceProviderOverride = provider;
}

export function getWorkspaceProvider(): WorkspaceProvider {
  if (!workspaceProviderOverride) {
    throw new Error('Workspace provider has not been initialized or registered.');
  }
  return workspaceProviderOverride;
}

export function getWorkspaceProviderOverride(): WorkspaceProvider | null {
  return workspaceProviderOverride;
}
