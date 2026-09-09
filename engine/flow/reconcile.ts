import type { DbConnection } from '../contract/index.ts';
import { enqueueJobIfAbsent } from '../jobs/jobs.ts';
import { planCycleJobId } from '../jobs/ids.ts';
import { DEFAULT_PLAN_ROUNDS_CEILING, REVIEW_PR_META_KEYS, DEFAULT_JUNIOR_COOLDOWN_MS } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';
import { notifyOperator } from '../state/notifications.ts';
import { ensureTaskAssignment, juniorIsOccupied, freeJuniors } from './assignment.ts';
import { assignJunior, resolveJunior, type JuniorConfig } from '../harness/antigravity.ts';
import { probeJuniorHealth } from '../harness/antigravity-seam.ts';
import { isJuniorHealthy, setJuniorUnhealthy } from './junior-health.ts';
import { evaluateAdmissionGate } from './admission_predicate.ts';

/**
 * N17 — the department's task queue manager (evolved from the plain
 * stranded-task reconciler).
 *
 * Filed tasks are born `queued` and WAIT HERE. A task is admitted — assigned a
 * junior + senior (the claim-time pin, `engine/flow/assignment.ts`) and handed
 * its deterministic `plan.cycle` job — only when a junior has capacity and is healthy.
 *
 * 3-Stage Admission Gate:
 * 1. Capacity check first: Verify free juniors (!juniorIsOccupied(db, j)). If none free,
 *    halt without any probing or cooldown reads.
 * 2. Cooldown check second: For candidate juniors, check isJuniorHealthy(db, j). If in
 *    cooldown, fall through to other free and healthy juniors.
 * 3. CDP Handshake probe last: Probe ONLY the pinned candidate free junior when there is
 *    a candidate task to admit. If probe fails, mark cooldown and fall through to another free junior.
 *
 * If no free junior is admissible: the sweep halts and candidate tasks wait in FIFO order.
 * If admitted: assign junior + senior and enqueue plan.cycle.
 *
 * @returns the task ids admitted this sweep, in queue order.
 */
export interface ReconcileOptions {
  probe?: (cfg: JuniorConfig) => Promise<boolean>;
  probeTimeoutMs?: number;
  /**
   * Junior auto-warmup hook: called (fire-and-forget, never awaited) when a
   * junior fails the CDP probe, so a COLD junior gets opened instead of merely
   * held (the C3 gap — docs/plan-junior-auto-warmup.md). Return true iff a warm
   * is in flight for the junior after the call; that drives the quiet rule
   * below (senior R2 — no operator page during a healthy warm). Default no-op
   * (returns undefined): unit tests never launch a real app, and the loud C3
   * behavior is unchanged.
   */
  requestWarmup?: (juniorId: string) => boolean | void;
}

export async function reconcileQueuedTasks(
  db: DbConnection,
  opts: ReconcileOptions = {}
): Promise<string[]> {
  const ceilingRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.REVIEW_PLAN_ROUNDS_CEILING
  );
  const ceiling = ceilingRow ? parseInt(ceilingRow.value, 10) : DEFAULT_PLAN_ROUNDS_CEILING;

  const candidates = db.all<{ id: string }>(
    `SELECT t.id FROM bureau_tasks t
     WHERE t.state = 'queued'
       AND t.archived_at IS NULL
       AND t.completed_at IS NULL
       AND t.assigned_junior IS NULL
       AND t.plan_rounds < ?
       AND NOT EXISTS (
         SELECT 1 FROM bureau_jobs j
         WHERE j.task_id = t.id AND j.kind = 'plan.cycle'
           AND j.state IN ('pending','running')
       )
     ORDER BY t.created_at ASC, t.id ASC`,
    Number.isFinite(ceiling) ? ceiling : DEFAULT_PLAN_ROUNDS_CEILING
  );

  const admitted: string[] = [];
  const probeFn = opts.probe ?? ((cfg: JuniorConfig) => probeJuniorHealth(cfg, { timeoutMs: opts.probeTimeoutMs }));

  for (const { id: taskId } of candidates) {
    // Stage 1: Capacity check first. Stop at first task no junior is free for.
    const free = freeJuniors().filter(j => !juniorIsOccupied(db, j));
    if (free.length === 0) {
      break;
    }

    // Operator-action / DEAD-cycle skip — BEFORE any junior probe (senior C3
    // note #1). A task we will not admit must not open a CDP socket or mark a
    // junior unhealthy: a DEAD plan.cycle row is never retried here (explicit
    // operator action), and the single exception is the capacity-defer signature
    // (a `done` cycle on a still-unassigned, round-0 task) which is reset below.
    const jobId = planCycleJobId(taskId);
    const existing = db.get<{ state: string }>('SELECT state FROM bureau_jobs WHERE id = ?', jobId);
    let resetDeferredCycle = false;
    if (existing) {
      if (existing.state !== 'done') continue;
      const rounds = db.get<{ plan_rounds: number }>(
        'SELECT plan_rounds FROM bureau_tasks WHERE id = ?',
        taskId
      );
      if (!rounds || rounds.plan_rounds > 0) continue;
      resetDeferredCycle = true;
    }

    const policy = assignJunior({ taskId });
    const candidateJuniors = free.includes(policy)
      ? [policy, ...free.filter(j => j !== policy)]
      : free;

    let candidateJuniorId: string | null = null;
    let probeFailedThisTask = false;
    const probeFailedJuniors: string[] = [];
    const warmingJuniors: string[] = [];

    for (const j of candidateJuniors) {
      // Stage 2: Cooldown check second.
      const inCooldown = !isJuniorHealthy(db, j);
      if (inCooldown) {
        evaluateAdmissionGate({ occupied: false, inCooldown: true });
        // Cooldown holds: try next free junior
        continue;
      }

      // Stage 3: CDP Handshake probe last.
      const probeOk = await probeFn(resolveJunior(j));
      const decision = evaluateAdmissionGate({ occupied: false, inCooldown: false, probeResult: probeOk });

      if (decision.action === 'admit') {
        candidateJuniorId = j;
        break;
      } else {
        // Probe failed: mark unhealthy in bureau_meta with cooldown so subsequent sweeps don't repeatedly probe
        probeFailedThisTask = true;
        probeFailedJuniors.push(j);
        setJuniorUnhealthy(db, j, DEFAULT_JUNIOR_COOLDOWN_MS, 'probe_failed');
        journal(db, {
          kind: 'guardrail',
          attribution: { actor_role: 'system', provider: 'deterministic', model: 'queue-policy', account: null },
          taskId,
          detail: {
            action: 'junior_unhealthy_hold',
            junior: j,
            reason: 'probe_failed'
          }
        });
        // AFTER the cooldown mark (the hook may observe/clear it): request a
        // background warm — a cold junior must be opened, not just held.
        if (opts.requestWarmup?.(j) === true) warmingJuniors.push(j);
        // Try next free junior!
        continue;
      }
    }

    if (!candidateJuniorId) {
      // No free junior is currently healthy and probe-passing. If that is because
      // every free junior FAILED the CDP probe (not merely cooldown/occupancy),
      // surface it LOUDLY — a systematically-wrong probe would otherwise brick the
      // whole queue silently (the senior's C3 concern). Naturally throttled: a
      // probe-failed junior enters cooldown, so probes only re-run once cooldown
      // expires, not every 100ms tick.
      if (probeFailedThisTask) {
        // Quiet rule (senior R2): a healthy cold start legitimately spans
        // multiple cooldown windows, and notifyOperator is a bare, undeduped
        // WARN — paging every window would cry "stalled" 1-3 times during a
        // HEALTHY auto-warm. Stay quiet (a `queue_probe_warming` span) while a
        // warm is in flight for every junior that probe-failed this sweep; go
        // loud only when some probe-failed junior has NO warm in flight (warm
        // failed into backoff, cap tripped, or warming disabled).
        const allWarming =
          probeFailedJuniors.length > 0 && probeFailedJuniors.every(j => warmingJuniors.includes(j));
        if (allWarming) {
          journal(db, {
            kind: 'system',
            attribution: { actor_role: 'system', provider: 'deterministic', model: 'queue-policy', account: null },
            taskId,
            detail: { action: 'queue_probe_warming', freeRoster: free, warming: warmingJuniors }
          });
        } else {
          journal(db, {
            kind: 'guardrail',
            attribution: { actor_role: 'system', provider: 'deterministic', model: 'queue-policy', account: null },
            taskId,
            detail: { action: 'queue_probe_roster_exhausted', freeRoster: free, warming: warmingJuniors }
          });
          notifyOperator(
            `queue-probe:${taskId}`,
            `Queue may be stalled: every free junior failed the CDP health probe for task ${taskId} ` +
              `(roster: ${free.join(', ')}). Check the junior IDEs / CDP ports — if the juniors ARE up, the ` +
              `health probe may be misfiring (verify JUNIOR health-probe endpoint semantics).`
          );
        }
      }
      // Break to wait for cooldown/recovery.
      break;
    }

    // Claim-time assignment: pin junior + senior, once, transactionally.
    const ensured = ensureTaskAssignment(db, taskId, { preferJunior: candidateJuniorId });
    if (ensured.status !== 'assigned') break;

    if (resetDeferredCycle) {
      const reset = db.execTransaction(() => {
        const res = db.run(
          `UPDATE bureau_jobs
           SET state = 'pending', attempts = 0, reaped_count = 0, last_error = NULL,
               run_after = NULL, lease_owner = NULL, lease_expires_at = NULL,
               started_at = NULL, finished_at = NULL
           WHERE id = ? AND state = 'done'`,
          jobId
        );
        if (res.changes === 0) return false;
        journal(db, {
          kind: 'system',
          attribution: { actor_role: 'system', provider: 'deterministic', model: 'queue-policy', account: null },
          taskId,
          jobId,
          detail: { action: 'flow_admit_requeue', reason: 'capacity_defer_cycle_reset' }
        });
        return true;
      });
      if (reset) admitted.push(taskId);
      continue;
    }

    const { inserted } = enqueueJobIfAbsent(db, {
      id: jobId,
      kind: 'plan.cycle',
      task_id: taskId,
      payload: { taskId },
      max_attempts: 1
    });
    if (inserted) {
      admitted.push(taskId);
    }
  }
  return admitted;
}
