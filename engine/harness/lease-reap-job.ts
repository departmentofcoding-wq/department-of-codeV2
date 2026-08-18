import type { JobContext, JobDefinition } from '../contract/types.ts';
import { reapExpiredWindowLeases } from './lease-manager.ts';

export async function handleLeaseReap(ctx: JobContext): Promise<void> {
  reapExpiredWindowLeases(ctx.db);
}

export const leaseReapJobDefinition: JobDefinition = {
  kind: 'lease.reap',
  schema: {},
  handler: handleLeaseReap,
  options: {
    maxAttempts: 3,
    timeoutMs: 30000
  }
};
