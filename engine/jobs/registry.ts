import { z } from 'zod';
import type { JobDefinition, JobHandler } from '../contract/index.ts';
import { enqueueJobIfAbsent } from './jobs.ts';

const registry = new Map<string, JobDefinition>();

export function defineJob<T>(
  kind: string,
  schema: z.ZodType<T>,
  handler: JobHandler,
  options?: { maxAttempts?: number; timeoutMs?: number }
): JobDefinition {
  const def: JobDefinition = {
    kind,
    schema,
    handler,
    options: {
      maxAttempts: options?.maxAttempts ?? 3,
      timeoutMs: options?.timeoutMs ?? 30000
    }
  };
  registry.set(kind, def);
  return def;
}

export function getJobDefinition(kind: string): JobDefinition | undefined {
  return registry.get(kind);
}

export function getRegisteredJobKinds(): string[] {
  return Array.from(registry.keys());
}

// --- Register Phase 0 Demo Handlers ---

// 1. demo.sleep
const demoSleepSchema = z.object({
  ms: z.number().optional().default(100)
});

defineJob(
  'demo.sleep',
  demoSleepSchema,
  async (ctx) => {
    const payload = demoSleepSchema.parse(ctx.payload ?? {});
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) {
        return reject(new Error('Job aborted prior to start'));
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, payload.ms);

      const onAbort = () => {
        cleanup();
        reject(new Error('Job aborted during sleep'));
      };

      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      ctx.signal.addEventListener('abort', onAbort);
    });
  },
  { maxAttempts: 3, timeoutMs: 10000 }
);

// 2. demo.chain (Enqueues 3 child sleep jobs idempotently)
const demoChainSchema = z.object({
  count: z.number().optional().default(3),
  ms: z.number().optional().default(50)
});

defineJob(
  'demo.chain',
  demoChainSchema,
  async (ctx) => {
    const payload = demoChainSchema.parse(ctx.payload ?? {});
    const count = payload.count;

    for (let i = 1; i <= count; i++) {
      if (ctx.signal.aborted) {
        throw new Error('Chain job aborted mid-sequence');
      }

      const childId = `${ctx.job.id}:sleep:${i}`;
      enqueueJobIfAbsent(ctx.db, {
        id: childId,
        kind: 'demo.sleep',
        task_id: ctx.job.task_id,
        payload: { ms: payload.ms },
        max_attempts: 3
      });
    }
  },
  { maxAttempts: 3, timeoutMs: 15000 }
);

// 3. demo.fail
const demoFailSchema = z.object({
  message: z.string().optional().default('Demo failure')
});

defineJob(
  'demo.fail',
  demoFailSchema,
  async (ctx) => {
    const payload = demoFailSchema.parse(ctx.payload ?? {});
    throw new Error(payload.message);
  },
  { maxAttempts: 3, timeoutMs: 5000 }
);

// 4. intake.turn
const intakeTurnSchema = z.object({
  sessionId: z.string()
});

defineJob(
  'intake.turn',
  intakeTurnSchema,
  async (ctx) => {
    const payload = intakeTurnSchema.parse(ctx.payload ?? {});
    const { runOfficerTurn } = await import('../officers/task_intake_officer.ts');
    await runOfficerTurn(ctx.db, payload.sessionId, {
      signal: ctx.signal,
      jobId: ctx.job.id
    });
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);
