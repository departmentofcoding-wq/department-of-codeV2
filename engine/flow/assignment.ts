import type { AttributionTuple, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { JUNIORS, assignJunior, resolveJunior } from '../harness/antigravity.ts';
import { assignSeniorForTask } from '../harness/senior.ts';

/**
 * N17 — claim-time flow assignment + junior capacity.
 *
 * The 2026-09-02 incident (three tasks filed within 42s, ALL claimed at once):
 * junior/senior identity was re-derived per phase (a hash of the task id at
 * each door) and "which conversation" was implicit ("whatever conversation is
 * current on that junior's window"). Under concurrency two tasks time-sliced
 * one window, prompts landed in the OTHER task's conversation, an unpinned
 * dispatch silently defaulted to junior A / the shared `window-default` lease
 * and opened a fresh session there — the operator watched junior B's approved
 * plan get handed to a brand-new junior-A conversation.
 *
 * The fix is one law, enforced here: **a task's junior and senior are decided
 * exactly once — transactionally, at claim — and persisted on the task row.**
 * Every later phase reads the pin. And a junior is only ever assigned while it
 * has capacity: a junior is OCCUPIED from its task's claim until the task
 * reaches a state where the junior is no longer needed (needs-review /
 * blocked / done / failed) or is archived. With two juniors in the roster, at
 * most two tasks are ever in flight — the rest wait in the filing queue.
 */

/** Attribution for the deterministic assignment act itself. */
const ASSIGNMENT_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'queue-policy',
  account: null
};

export interface TaskAssignment {
  junior: string;
  senior: string;
  assignedAt: string;
  /** False when an existing pin was returned (the common case). */
  fresh: boolean;
}

export type EnsureAssignmentResult =
  | { status: 'assigned'; assignment: TaskAssignment }
  | { status: 'unavailable'; reason: 'no_free_junior'; busy: string[] };

/**
 * A junior is occupied while ANY unarchived task pinned to it sits in a state
 * where the department may still drive it:
 *   - `queued`  → but ONLY while its plan cycle is live (pending/running). A
 *     queued task whose cycle died holds nothing — the failed-cycle rule keeps
 *     it an operator action, and the junior must not stay reserved forever.
 *   - `claimed` / `verifying` → the junior's conversation/work is mid-flight
 *     (implementation, fix rounds, verify sendbacks). These occupy even when
 *     no job is live for a moment: the task's half-done work lives in that
 *     junior's conversation and MUST NOT be interleaved with another task.
 * needs-review / blocked / done / failed free the junior (a blocked or
 * needs-review task waits on a human, not on the junior).
 */
export function juniorIsOccupied(db: DbConnection, junior: string): boolean {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_tasks t
     WHERE t.assigned_junior = ?
       AND t.archived_at IS NULL
       AND (
         t.state IN ('claimed','verifying')
         OR (
           t.state = 'queued'
           AND EXISTS (
             SELECT 1 FROM bureau_jobs j
             WHERE j.task_id = t.id AND j.kind = 'plan.cycle'
               AND j.state IN ('pending','running')
           )
         )
       )`,
    junior
  );
  return !!row && row.n > 0;
}

/** The juniors currently free, in stable roster order. */
export function freeJuniors(): string[] {
  return Object.keys(JUNIORS).sort();
}

/**
 * Read a task's pin without creating one. Returns null for unadmitted tasks.
 */
export function readTaskAssignment(
  db: DbConnection,
  taskId: string
): TaskAssignment | null {
  const t = db.get<{ assigned_junior: string | null; assigned_senior: string | null; assigned_at: string | null }>(
    'SELECT assigned_junior, assigned_senior, assigned_at FROM bureau_tasks WHERE id = ?',
    taskId
  );
  if (!t || !t.assigned_junior || !t.assigned_senior) return null;
  return {
    junior: t.assigned_junior,
    senior: t.assigned_senior,
    assignedAt: t.assigned_at ?? '',
    fresh: false
  };
}

export interface EnsureAssignmentOptions {
  /** Explicit junior pin (operator/CLI). Wins over policy for the FRESH
   *  assignment only — an existing pin is immutable and returned as-is. */
  preferJunior?: string;
  /** Explicit senior pin, same contract as preferJunior. */
  preferSenior?: string;
  /** Attribution for the assignment journal span (defaults to the
   *  deterministic queue policy). */
  attribution?: AttributionTuple;
  /** Job invoking the assignment, for span attribution. */
  jobId?: string;
  /**
   * Legacy/degraded mode for tasks that are ALREADY mid-flight without a pin
   * (created before N17, e.g. a claimed task being re-driven by rekick): pick
   * the deterministic-policy junior even when every junior is busy, rather
   * than stranding the task. The capacity law still holds for every NEW
   * admission (the queue manager never sets this).
   */
  allowBusyPick?: boolean;
  /** Test seam: override the roster/capacity view. */
  __rosterForTest?: string[];
}

/**
 * Decide + persist a task's junior/senior pin, once. Transactional and
 * idempotent: concurrent callers race on `WHERE assigned_junior IS NULL`, the
 * loser re-reads and returns the winner's pin. A fresh assignment journals an
 * `assignment` span — the claim act is on the record, reviewable later.
 *
 * Junior selection for a fresh pin, in order:
 *   1. explicit `preferJunior` (operator/CLI trust),
 *   2. `JUNIOR_DEFAULT` env, then the deterministic task-id policy — but only
 *      if that junior is FREE (capacity first, determinism second),
 *   3. any other free junior (stable roster order).
 * With `allowBusyPick`, step 2/3 fall back to the deterministic pick when no
 * junior is free (legacy recovery only).
 */
export function ensureTaskAssignment(
  db: DbConnection,
  taskId: string,
  opts: EnsureAssignmentOptions = {}
): EnsureAssignmentResult {
  const existing = readTaskAssignment(db, taskId);
  if (existing) return { status: 'assigned', assignment: existing };

  const roster = (opts.__rosterForTest ?? freeJuniors()).slice().sort();
  const busy: string[] = roster.filter(j => juniorIsOccupied(db, j));

  let picked: string | undefined;
  let basis: string;
  if (opts.preferJunior) {
    // An explicit pin is honored as-is (it may deliberately double up — e.g. an
    // operator rekick pinning a task back onto its junior).
    picked = resolveJunior(opts.preferJunior).id;
    basis = 'explicit-pin';
  } else {
    const policy = assignJunior({ taskId });
    const free = roster.filter(j => !busy.includes(j));
    if (free.includes(policy)) {
      picked = policy;
      basis = 'policy-free';
    } else if (free.length > 0) {
      picked = free[0]!;
      basis = 'first-free';
    } else if (opts.allowBusyPick) {
      picked = policy;
      basis = 'policy-busy-legacy-pick';
    } else {
      return { status: 'unavailable', reason: 'no_free_junior', busy };
    }
  }

  const senior = opts.preferSenior ?? assignSeniorForTask(taskId);
  const attribution = opts.attribution ?? ASSIGNMENT_ATTRIBUTION;
  const now = new Date().toISOString();

  const updated = db.execTransaction(() => {
    const res = db.get<BureauTaskRow>(
      `UPDATE bureau_tasks
       SET assigned_junior = ?, assigned_senior = ?, assigned_at = ?, updated_at = ?
       WHERE id = ? AND assigned_junior IS NULL AND assigned_senior IS NULL
       RETURNING *`,
      picked,
      senior,
      now,
      now,
      taskId
    );
    if (res) {
      journal(db, {
        kind: 'assignment',
        attribution,
        taskId,
        jobId: opts.jobId ?? null,
        detail: {
          action: 'task_assigned',
          junior: picked,
          senior,
          basis,
          freeRoster: roster.filter(j => !busy.includes(j)),
          busyRoster: busy
        }
      });
    }
    return res;
  });

  if (updated) {
    return {
      status: 'assigned',
      assignment: { junior: updated.assigned_junior!, senior: updated.assigned_senior!, assignedAt: updated.assigned_at!, fresh: true }
    };
  }
  // A concurrent writer pinned first: return their pin, never overwrite.
  const raced = readTaskAssignment(db, taskId);
  if (raced) return { status: 'assigned', assignment: raced };
  return { status: 'unavailable', reason: 'no_free_junior', busy };
}
