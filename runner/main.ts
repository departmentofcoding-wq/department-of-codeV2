import { z } from 'zod';
import { pathToFileURL } from 'node:url';

import type { BureauJobRow, DbConnection } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { journal } from '../engine/journal/writer.ts';
import {
  claimJob,
  claimJobById,
  completeJob,
  failJob,
  heartbeatJob,
  reapExpiredJobs,
  NonRetryableError,
  FOREMAN_ATTRIBUTION
} from '../engine/jobs/jobs.ts';
import { reconcileQueuedTasks } from '../engine/flow/reconcile.ts';
// Importing the registry registers the job handlers as a module side effect.
import { getJobDefinition } from '../engine/jobs/registry.ts';

import { notifyOperator as engineNotifyOperator } from '../engine/state/notifications.ts';

// 1. Zod Environment Variable Config. BUREAU_DB_PATH has no default here on
// purpose: the engine's boot door owns the one default, stated once.
// BUREAU_LEASE_MS default is 30s (was 5s): the heartbeat renews every 1s, so a
// live job's lease should never come near expiry — but any handler that blocks
// the event loop longer than the lease (a sync subprocess, a long GC pause)
// gets reaped and DUPLICATED by a co-running runner before this stream made
// every provider async. 30s is headroom for the remaining sync islands, not a
// target; the reaper still recovers a genuinely dead runner within 30s + poll.
export const runnerConfigSchema = z.object({
  BUREAU_DB_PATH: z.string().optional(),
  BUREAU_POLL_MS: z.coerce.number().default(100),
  BUREAU_LEASE_MS: z.coerce.number().default(30000),
  BUREAU_HEARTBEAT_MS: z.coerce.number().default(1000)
});

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export interface OperatorNotifier {
  notifyOperator(jobId: string, reason: string): void;
}

export const defaultNotifier: OperatorNotifier = {
  notifyOperator(jobId: string, reason: string): void {
    engineNotifyOperator(jobId, reason);
  }
};

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data ?? {})
    })
  );
}

/** A stuck handler must not be able to hang shutdown forever. */
const STOP_TIMEOUT_MS = 10_000;

import { getWorkspaceProviderOverride, setWorkspaceProvider } from '../engine/contract/workspace-seam.ts';
import { GitWorkspaceProvider } from '../engine/worktrees/manager.ts';
import { getPrProviderOverride, setPrProviderOverride } from '../engine/contract/pr-seam.ts';
import { GhCliPrProvider } from '../engine/delivery/gh_cli_pr_provider.ts';
import { getIdeDriverOverride, setIdeDriverOverride } from '../engine/contract/ide-driver-seam.ts';
import { CdpIdeDriver } from '../engine/harness/cdp-client.ts';
import { GatedIdeDriver } from '../engine/selectors/gate.ts';
import { reapExpiredWindowLeases } from '../engine/harness/lease-manager.ts';

function getSelectorCss(db: DbConnection, key: string): string {
  const row = db.get<{ css: string }>('SELECT css FROM bureau_selectors WHERE key = ?', key);
  if (!row) {
    throw new Error(`Selector key '${key}' not found in bureau_selectors`);
  }
  return row.css;
}

export class Runner {
  public readonly id: string;
  private db: DbConnection;
  private config: RunnerConfig;
  private notifier: OperatorNotifier;
  private isStopping = false;
  private shutdownController = new AbortController();
  private activeJobs = new Set<Promise<void>>();
  private runningJobIds = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /**
   * Job kinds this Runner must not claim because another executor owns them.
   * Per-Runner, not global: the console's in-process Runner excludes
   * `intake.turn` (the console drains those inline via claimJobById, so the two
   * would otherwise race), while a standalone `npm run runner` excludes nothing
   * and drains every kind — including intake, which the durability/resume path
   * relies on.
   */
  private excludeKinds: readonly string[];

  constructor(
    db: DbConnection,
    config?: Partial<RunnerConfig>,
    notifier?: OperatorNotifier,
    options?: { excludeKinds?: readonly string[] }
  ) {
    this.id = `runner-${crypto.randomUUID()}`;
    this.db = db;
    this.config = runnerConfigSchema.parse({
      BUREAU_DB_PATH: process.env.BUREAU_DB_PATH,
      BUREAU_POLL_MS: process.env.BUREAU_POLL_MS,
      BUREAU_LEASE_MS: process.env.BUREAU_LEASE_MS,
      BUREAU_HEARTBEAT_MS: process.env.BUREAU_HEARTBEAT_MS,
      ...(config ?? {})
    });
    this.notifier = notifier ?? defaultNotifier;
    this.excludeKinds = options?.excludeKinds ?? [];

    if (!getWorkspaceProviderOverride()) {
      setWorkspaceProvider(new GitWorkspaceProvider());
    }

    if (!getPrProviderOverride()) {
      setPrProviderOverride(new GhCliPrProvider());
    }

    if (!getIdeDriverOverride()) {
      setIdeDriverOverride(new GatedIdeDriver(new CdpIdeDriver((key) => getSelectorCss(this.db, key)), this.db));
    }
  }


  public start(): void {
    log('INFO', 'runner_started', { runnerId: this.id, config: this.config });

    // Start Heartbeat Loop
    this.heartbeatTimer = setInterval(() => {
      this.doHeartbeat();
    }, this.config.BUREAU_HEARTBEAT_MS);

    // Start Main Loop
    this.loop();
  }

  public async stop(): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;
    log('INFO', 'runner_stopping', { runnerId: this.id });

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Abort active controllers
    this.shutdownController.abort();

    // Await all active running jobs to finish settling — but never forever:
    // a handler that ignores its abort signal gets logged and abandoned.
    await Promise.race([
      Promise.allSettled(Array.from(this.activeJobs)),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log('ERROR', 'runner_stop_timeout', {
            runnerId: this.id,
            unsettled: Array.from(this.runningJobIds)
          });
          resolve();
        }, STOP_TIMEOUT_MS);
      })
    ]);

    log('INFO', 'runner_stopped', { runnerId: this.id });
  }

  private async loop(): Promise<void> {
    while (!this.isStopping) {
      try {
        // Reconcile queued tasks that have no cycle behind them
        this.reconcileQueuedTasks();

        // Watchdog & Reaper tick
        this.runReaperAndWatchdog();

        // Attempt job claim, skipping any kinds another executor owns (the
        // console excludes intake.turn, which it drains inline via claimJobById;
        // a standalone runner excludes nothing).
        const job = claimJob(this.db, this.id, this.config.BUREAU_LEASE_MS, this.excludeKinds);
        if (job) {
          const jobPromise = this.executeJob(job);
          this.activeJobs.add(jobPromise);
          jobPromise.finally(() => this.activeJobs.delete(jobPromise));
        }
      } catch (err: any) {
        log('ERROR', 'runner_loop_error', { error: err.message });
      }

      if (!this.isStopping) {
        await new Promise((res) => {
          this.pollTimer = setTimeout(res, this.config.BUREAU_POLL_MS);
        });
      }
    }
  }

  /**
   * Self-healing safety net for the auto-kickoff flow: enqueue a plan.cycle for
   * any queued task that has none. Delegates to the engine reconcile door so the
   * logic is unit-testable without constructing a full Runner. See
   * engine/flow/reconcile.ts for why it is bounded and idempotent.
   */
  public reconcileQueuedTasks(): void {
    for (const taskId of reconcileQueuedTasks(this.db)) {
      log('INFO', 'reconciler_enqueued_plan_cycle', { taskId });
    }
  }

  private runReaperAndWatchdog(): void {
    // 0. Reap expired window leases
    reapExpiredWindowLeases(this.db);

    // 1. Reap expired jobs
    const reaped = reapExpiredJobs(this.db);
    for (const job of reaped) {
      log('WARN', 'lease_reaped', { jobId: job.id, reapedCount: job.reaped_count });
    }

    // 2. Watchdog: Flag running/pending jobs whose lease repeatedly expired (reaped_count >= 3)
    const repeatedlyReaped = this.db.all<BureauJobRow>(
      `SELECT * FROM bureau_jobs WHERE state IN ('pending', 'running') AND reaped_count >= 3`
    );

    const now = new Date().toISOString();
    for (const job of repeatedlyReaped) {
      this.db.execTransaction(() => {
        this.db.run(
          `UPDATE bureau_jobs
           SET state = 'dead',
               finished_at = ?,
               last_error = 'Reaped 3 or more times (watchdog dead-letter)',
               lease_owner = NULL,
               lease_expires_at = NULL
           WHERE id = ?`,
          now,
          job.id
        );

        journal(this.db, {
          kind: 'system',
          attribution: FOREMAN_ATTRIBUTION,
          taskId: job.task_id,
          jobId: job.id,
          detail: { action: 'watchdog_dead_letter', reaped_count: job.reaped_count }
        });
      });

      log('ERROR', 'watchdog_flagged_dead', { jobId: job.id, reapedCount: job.reaped_count });
      this.notifier.notifyOperator(job.id, `Watchdog flagged dead: reaped ${job.reaped_count} times`);
    }
  }

  private doHeartbeat(): void {
    for (const jobId of Array.from(this.runningJobIds)) {
      try {
        const ok = heartbeatJob(this.db, jobId, this.id, this.config.BUREAU_LEASE_MS);
        if (!ok) {
          log('WARN', 'heartbeat_failed', { jobId, runnerId: this.id });
        }
      } catch (err: any) {
        log('ERROR', 'heartbeat_error', { jobId, error: err.message });
      }
    }
  }

  public async executeJob(job: BureauJobRow): Promise<void> {
    this.runningJobIds.add(job.id);
    log('INFO', 'job_started', { jobId: job.id, kind: job.kind });

    const def = getJobDefinition(job.kind);
    if (!def) {
      log('ERROR', 'unknown_job_kind', { jobId: job.id, kind: job.kind });
      const { terminal } = failJob(this.db, job.id, `Unknown job kind: ${job.kind}`, 0);
      if (terminal) {
        this.notifier.notifyOperator(job.id, `Unknown job kind: ${job.kind}`);
      }
      this.runningJobIds.delete(job.id);
      return;
    }

    // Composed AbortController: timeout or shutdown signal
    const jobAbortController = new AbortController();

    const onShutdownAbort = () => jobAbortController.abort();
    this.shutdownController.signal.addEventListener('abort', onShutdownAbort);

    const timeoutMs = def.options.timeoutMs;
    const timeoutTimer = setTimeout(() => {
      jobAbortController.abort();
    }, timeoutMs);

    try {
      const payload = JSON.parse(job.payload || '{}');
      await def.handler({
        db: this.db,
        job,
        payload,
        signal: jobAbortController.signal
      });

      completeJob(this.db, job.id);
      log('INFO', 'job_completed', { jobId: job.id });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const nonRetryable = err instanceof NonRetryableError || err?.nonRetryable === true;
      log('WARN', 'job_failed', { jobId: job.id, error: errMsg, attempts: job.attempts + 1, nonRetryable });

      // Calculate exponential backoff: 100 * 2^(attempts)
      const backoffMs = 100 * Math.pow(2, job.attempts);
      const { terminal } = failJob(this.db, job.id, errMsg, backoffMs, { forceTerminal: nonRetryable });

      if (terminal) {
        this.notifier.notifyOperator(job.id, `Terminal failure: ${errMsg}`);
      }
    } finally {
      clearTimeout(timeoutTimer);
      this.shutdownController.signal.removeEventListener('abort', onShutdownAbort);
      this.runningJobIds.delete(job.id);
    }
  }
}

export async function drainSingleJob(db: DbConnection, jobId: string): Promise<void> {
  const runnerId = `runner-cli-${crypto.randomUUID()}`;
  const claimedJob = claimJobById(db, jobId, runnerId, 60000);

  if (!claimedJob) {
    const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);
    if (job?.state === 'done') return;
    throw new Error(`Job ${jobId} could not be claimed (state=${job?.state ?? 'not_found'})`);
  }

  const runner = new Runner(db);
  await runner.executeJob(claimedJob);
}

// --- Standalone process entrypoint ---------------------------------------

async function main(): Promise<void> {
  const config = runnerConfigSchema.parse(process.env);
  const { loadGoogleKeysFromDisk } = await import('../engine/llm/google_keys.ts');
  loadGoogleKeysFromDisk();
  const conn = openDbConnection(config.BUREAU_DB_PATH);
  const runner = new Runner(conn, config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', 'shutdown_signal', { signal });
    void runner.stop().then(() => {
      conn.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  runner.start();
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isCli) {
  log('INFO', 'runner_main_cli_start');
  void main();
}
