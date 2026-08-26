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

// 5. verify.run
const verifyRunSchema = z.object({
  taskId: z.string()
});

defineJob(
  'verify.run',
  verifyRunSchema,
  async (ctx) => {
    const { executeVerifyRunJob } = await import('../verify/job.ts');
    await executeVerifyRunJob(ctx);
  },
  { maxAttempts: 3, timeoutMs: 180000 }
);

// 6. worktree.prepare
const worktreePrepareSchema = z.object({
  taskId: z.string()
});

defineJob(
  'worktree.prepare',
  worktreePrepareSchema,
  async (ctx) => {
    const { handleWorktreePrepare } = await import('../worktrees/job.ts');
    await handleWorktreePrepare(ctx);
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);

// 7. junior.dispatch
const juniorDispatchSchema = z.object({
  dispatchId: z.string(),
  windowTarget: z.string().optional(),
  url: z.string().optional(),
  actions: z.array(z.object({ selectorKey: z.string(), action: z.string(), value: z.string().optional() })).optional()
});

defineJob(
  'junior.dispatch',
  juniorDispatchSchema,
  async (ctx) => {
    const { handleJuniorDispatch } = await import('../harness/dispatch-job.ts');
    await handleJuniorDispatch(ctx);
  },
  // The Antigravity prompt path drives a live GUI agent that legitimately runs
  // for many minutes (adaptive wait, no hard cap); the old 120s ceiling only
  // worked because the CDP path ignored its abort signal. The signal is now
  // honored through the wait, so this timeout is real again — and generous.
  { maxAttempts: 3, timeoutMs: 30 * 60 * 1000 }
);

// 8. lease.reap
const leaseReapSchema = z.object({});

defineJob(
  'lease.reap',
  leaseReapSchema,
  async (ctx) => {
    const { handleLeaseReap } = await import('../harness/lease-reap-job.ts');
    await handleLeaseReap(ctx);
  },
  { maxAttempts: 3, timeoutMs: 30000 }
);

// 9. selector.calibrate
const selectorCalibrateSchema = z.object({
  key: z.string(),
  maxReads: z.number().optional().default(3)
});

defineJob(
  'selector.calibrate',
  selectorCalibrateSchema,
  async (ctx) => {
    const { selectorCalibrateHandler } = await import('../selectors/registry.ts');
    await selectorCalibrateHandler(ctx);
  },
  { maxAttempts: 3, timeoutMs: 30000 }
);

// 10. pr.create
const prCreateSchema = z.object({
  taskId: z.string()
});

defineJob(
  'pr.create',
  prCreateSchema,
  async (ctx) => {
    const { handlePrCreate } = await import('../delivery/pr_create.ts');
    await handlePrCreate(ctx);
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);

// 11. pr.merge
const prMergeSchema = z.object({
  taskId: z.string(),
  prNumber: z.number().optional()
});

defineJob(
  'pr.merge',
  prMergeSchema,
  async (ctx) => {
    const { handlePrMerge } = await import('../delivery/pr_merge.ts');
    await handlePrMerge(ctx);
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);

// 12. senior.review-plan
const seniorReviewPlanSchema = z.object({
  taskId: z.string(),
  planId: z.string().optional()
});

defineJob(
  'senior.review-plan',
  seniorReviewPlanSchema,
  async (ctx) => {
    const { handleSeniorReviewPlan } = await import('../review/plan_review_job.ts');
    await handleSeniorReviewPlan(ctx);
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);

// 13. senior.review-work
const seniorReviewWorkSchema = z.object({
  taskId: z.string()
});

defineJob(
  'senior.review-work',
  seniorReviewWorkSchema,
  async (ctx) => {
    const { handleSeniorReviewWork } = await import('../review/work_review_job.ts');
    await handleSeniorReviewWork(ctx);
  },
  { maxAttempts: 3, timeoutMs: 90000 }
);

// 14. watchdog.sweep
const watchdogSweepSchema = z.object({
  limit: z.number().optional()
});

defineJob(
  'watchdog.sweep',
  watchdogSweepSchema,
  async (_ctx) => {},
  { maxAttempts: 3, timeoutMs: 30000 }
);

// 15. watchdog.recover
const watchdogRecoverSchema = z.object({
  findingId: z.string(),
  taskId: z.string().optional(),
  action: z.string().optional()
});

defineJob(
  'watchdog.recover',
  watchdogRecoverSchema,
  async (ctx) => {
    const { handleWatchdogRecover } = await import('../watchdog/recover.ts');
    await handleWatchdogRecover(ctx);
  },
  { maxAttempts: 3, timeoutMs: 30000 }
);

// 16. backup.push
const backupPushSchema = z.object({
  target: z.string().optional()
});

defineJob(
  'backup.push',
  backupPushSchema,
  async (ctx) => {
    const { handleBackupPush } = await import('../durability/backup_push.ts');
    await handleBackupPush(ctx);
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);

// 17. secretary.claim
const secretaryClaimSchema = z.object({
  key: z.string(),
  holderId: z.string(),
  holderRole: z.string(),
  leaseMs: z.number().optional(),
  notes: z.string().optional()
});

defineJob(
  'secretary.claim',
  secretaryClaimSchema,
  async (ctx) => {
    const { handleSecretaryClaim } = await import('../secretary/ownership.ts');
    await handleSecretaryClaim(ctx);
  },
  { maxAttempts: 3, timeoutMs: 30000 }
);

// 18. secretary.release
const secretaryReleaseSchema = z.object({
  key: z.string(),
  holderId: z.string()
});

defineJob(
  'secretary.release',
  secretaryReleaseSchema,
  async (ctx) => {
    const { handleSecretaryRelease } = await import('../secretary/ownership.ts');
    await handleSecretaryRelease(ctx);
  },
  { maxAttempts: 3, timeoutMs: 30000 }
);

// 19. plan.cycle — the integrated plan-review flow: junior authors, rubric
// gates, senior reviews; approve → junior.dispatch, revise → next round with
// feedback, all bounded by the plan_rounds ceiling. Long timeout because both
// agents are live GUI/CLI seniors; one attempt per round (a failure surfaces to
// the operator rather than re-prompting the agents).
const planCycleSchema = z.object({
  taskId: z.string(),
  junior: z.string().optional(),
  seniorId: z.string().optional(),
  juniorModel: z.string().optional(),
  seniorModel: z.string().optional(),
  folder: z.string().optional(),
  juniorStallMs: z.number().optional(),
  priorFeedback: z.string().optional()
});

defineJob(
  'plan.cycle',
  planCycleSchema,
  async (ctx) => {
    const payload = planCycleSchema.parse(ctx.payload ?? {});
    const { runPlanReviewCycle } = await import('../flow/plan_review_cycle.ts');
    await runPlanReviewCycle(ctx.db, { ...payload, signal: ctx.signal, jobId: ctx.job.id });
  },
  { maxAttempts: 1, timeoutMs: 45 * 60 * 1000 }
);

// 20. work.cycle — the post-implementation half of the flow: after the junior
// implements (junior.dispatch with chainWorkReview), a senior READS THE
// WALKTHROUGH and returns a verdict. Long timeout (a live GUI/CLI senior); one
// attempt (a failure surfaces to the operator rather than re-driving the agent).
const workCycleSchema = z.object({
  taskId: z.string(),
  seniorId: z.string().optional(),
  seniorModel: z.string().optional(),
  junior: z.string().optional(),
  juniorModel: z.string().optional(),
  folder: z.string().optional(),
  walkthrough: z.string().optional()
});

defineJob(
  'work.cycle',
  workCycleSchema,
  async (ctx) => {
    const payload = workCycleSchema.parse(ctx.payload ?? {});
    const { runWorkReviewCycle } = await import('../flow/work_review_cycle.ts');
    await runWorkReviewCycle(ctx.db, { ...payload, signal: ctx.signal, jobId: ctx.job.id });
  },
  { maxAttempts: 1, timeoutMs: 45 * 60 * 1000 }
);

// 21. project.provision — job-driven project provisioning: directory creation,
// git init, remote repo creation via RepoProvider, and DB registration.
const projectProvisionSchema = z.object({
  name: z.string(),
  description: z.string().optional().nullable(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  projectsRoot: z.string().optional(),
  repoPrefix: z.string().optional(),
  githubOwner: z.string().optional(),
  attribution: z.object({
    actor_role: z.string(),
    provider: z.string(),
    model: z.string(),
    account: z.string().nullable().optional()
  })
});

defineJob(
  'project.provision',
  projectProvisionSchema,
  async (ctx) => {
    const payload = projectProvisionSchema.parse(ctx.payload ?? {});
    const { provisionProject } = await import('../projects/provision.ts');
    await provisionProject(ctx.db, payload as any);
  },
  { maxAttempts: 3, timeoutMs: 60000 }
);

