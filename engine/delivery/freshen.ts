import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AttributionTuple, BureauTaskRow, DbConnection, JobContext } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { notifyOperator } from '../state/notifications.ts';
import { DeliveryError, PrRefusalError } from './types.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { runStagedVerifier } from '../verify/verifier.ts';
import { VERIFIER_ATTRIBUTION, DEFAULT_PR_BASE_BRANCH, REVIEW_PR_META_KEYS } from '../contract/constants.ts';

const execFileAsync = promisify(execFile);

const SYSTEM_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

/**
 * How many completed freshen cycles a task may consume. Each cycle is one
 * `delivery.freshen` job that reached a terminal job state; the budget stops
 * an automatic conflict→freshen→conflict loop when main keeps moving under a
 * task. The count reads the job rows themselves — every async step is a row,
 * so the rows ARE the budget record. Exhaustion is a journal span + operator
 * notification, never a silent refusal.
 */
export const FRESHEN_CYCLE_BUDGET = 2;

/**
 * Enqueue a delivery.freshen job for the task unless one is already in flight
 * (idempotent — a re-fired pr.merge conflict must not stack freshen jobs).
 */
export function enqueueDeliveryFreshenIfAbsent(db: DbConnection, taskId: string): string | undefined {
  const inFlight = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_jobs
      WHERE task_id = ? AND kind = 'delivery.freshen' AND state IN ('pending','running')`,
    taskId
  );
  if (inFlight && inFlight.n > 0) return undefined;
  return enqueueJob(db, { kind: 'delivery.freshen', task_id: taskId, payload: { taskId } }).id;
}

function resolveBaseBranch(db: DbConnection): string {
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    REVIEW_PR_META_KEYS.PR_BASE_BRANCH
  );
  return row?.value || DEFAULT_PR_BASE_BRANCH;
}

/**
 * delivery.freshen — the recovery for a delivery conflict (PR "not mergeable"
 * because main moved under the task branch). It runs IN the task's worktree:
 *
 *   1. `git fetch origin <base>` + `git merge origin/<base> --no-edit`
 *   2. CONFLICT → collect the unmerged files, `git merge --abort`, verify the
 *      branch is byte-identical to before (tip + porcelain), journal a
 *      `delivery_conflict` report, notify the operator, and STOP. The task
 *      stays at needs-review; a human/junior reconciles, then re-drives.
 *   3. CLEAN → re-run the SAME staged verifier against the freshened tree
 *      (a clean git merge can still break tests — a semantic conflict), then
 *      enqueue `work.diff-review` so the assigned senior records the phase4
 *      gate at the NEW tip (delivery requires reviewed_commit == tip), which
 *      on APPROVE chains pr.create → pr.merge through the existing path.
 *
 * Non-destruction law for this handler: no `-X ours/-X theirs`, no rebase, no
 * `reset`, no force-push, ever. A conflict is reported, never auto-resolved —
 * auto-resolution is the one operation that could silently drop the junior's
 * or main's side of an overlapping edit. The task never leaves needs-review:
 * this mirrors the proven manual N15 repair (2026-09-02), which held the task
 * at the gate throughout.
 *
 * The reverify runs inside this job rather than re-entering `verify.run`
 * because the verify job's state machine only admits `claimed`/`verifying`
 * tasks — needs-review → verifying is not a legal transition, and changing
 * the transition law for a delivery repair is not worth the blast radius.
 */
export async function handleDeliveryFreshen(ctx: JobContext): Promise<void> {
  const db = ctx.db;
  const taskId = (ctx.payload?.taskId as string | undefined) || ctx.job.task_id;
  if (!taskId) {
    throw new DeliveryError('delivery.freshen job missing taskId in payload or job row', 'MISSING_TASK_ID');
  }

  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new DeliveryError(`Task ${taskId} not found`, 'TASK_NOT_FOUND', taskId);
  }
  if (task.state !== 'needs-review') {
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'delivery.freshen', status: 'refused', reason: `task state is ${task.state} (must be needs-review)` }
    });
    throw new PrRefusalError(
      `Task ${taskId} cannot freshen from state ${task.state} (must be needs-review)`,
      'FRESHEN_OFF_GATE',
      taskId
    );
  }

  const wtRow = db.get<{ path: string }>(
    "SELECT path FROM bureau_worktrees WHERE task_id = ? AND status <> 'removed'",
    taskId
  );
  if (!wtRow || !wtRow.path) {
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'delivery.freshen', status: 'refused', reason: 'no active worktree' }
    });
    notifyOperator(`freshen:${taskId}`, `Task ${taskId} freshen refused: no active worktree.`);
    throw new PrRefusalError(`Task ${taskId} has no active worktree to freshen`, 'FRESHEN_NO_WORKTREE', taskId);
  }

  // Budget: count terminal delivery.freshen jobs for this task (this job is
  // 'running' and does not count itself). Exhaustion surfaces loudly and does
  // no git work at all.
  const prior = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_jobs
      WHERE kind = 'delivery.freshen' AND task_id = ? AND state IN ('done','dead','failed')`,
    taskId
  );
  if ((prior?.n ?? 0) >= FRESHEN_CYCLE_BUDGET) {
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'delivery.freshen', status: 'budget_exhausted', cycles: prior?.n }
    });
    notifyOperator(
      `freshen:${taskId}`,
      `Task ${taskId} exhausted its ${FRESHEN_CYCLE_BUDGET} freshen cycles (main keeps moving under the branch). No git operations were performed; deliver manually or re-file.`
    );
    return;
  }

  const baseBranch = resolveBaseBranch(db);
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: wtRow.path, encoding: 'utf-8' });
    return stdout.trim();
  };

  const tipBefore = await git(['rev-parse', 'HEAD']);

  // Refuse to merge into a dirty tree: uncommitted junior edits must never be
  // tangled into a merge commit (the non-destruction law).
  const porcelainBefore = await git(['status', '--porcelain']);
  if (porcelainBefore !== '') {
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: { action: 'delivery.freshen', status: 'refused', reason: 'worktree dirty at freshen start' }
    });
    notifyOperator(`freshen:${taskId}`, `Task ${taskId} freshen refused: worktree is dirty (checkpoint it first).`);
    throw new PrRefusalError(
      `Task ${taskId} worktree is dirty; freshen refuses to merge into uncommitted changes`,
      'FRESHEN_DIRTY_TREE',
      taskId
    );
  }

  try {
    await git(['fetch', 'origin', baseBranch]);
  } catch (err: any) {
    // A fetch failure is transient (network/credentials) — retryable.
    throw new DeliveryError(
      `delivery.freshen fetch failed for task ${taskId}: ${err?.stderr || err?.message || String(err)}`,
      'FRESHEN_FETCH_FAILED',
      taskId
    );
  }

  try {
    await git(['merge', `origin/${baseBranch}`, '--no-edit']);
  } catch (mergeErr: any) {
    // The merge refused to complete (conflict, or another git-level refusal).
    // NEVER resolve it here: collect the unmerged paths, abort best-effort,
    // and let the mandatory self-check below decide whether the branch is
    // pristine. If it is not, that is a loud CRITICAL, not a silent fix.
    let conflictedFiles: string[] = [];
    try {
      conflictedFiles = (await git(['diff', '--name-only', '--diff-filter=U']))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      conflictedFiles = [];
    }
    try {
      await git(['merge', '--abort']);
    } catch {
      // An abort that itself fails (e.g. no merge was ever in progress) is
      // covered by the self-check below — it is the authority.
    }

    const tipAfterAbort = await git(['rev-parse', 'HEAD']);
    const porcelainAfterAbort = await git(['status', '--porcelain']);
    if (tipAfterAbort !== tipBefore || porcelainAfterAbort !== '') {
      journal(db, {
        kind: 'guardrail',
        attribution: SYSTEM_ATTRIBUTION,
        taskId,
        detail: {
          action: 'delivery.freshen',
          status: 'abort_unclean',
          tipBefore,
          tipAfterAbort,
          porcelain: porcelainAfterAbort,
          error: mergeErr?.stderr || mergeErr?.message || String(mergeErr)
        }
      });
      notifyOperator(
        `freshen:${taskId}`,
        `CRITICAL: task ${taskId} freshen abort left the worktree not-pristine (tip ${tipAfterAbort.slice(0, 10)}). Inspect manually — nothing was auto-resolved.`
      );
      throw new PrRefusalError(
        `delivery.freshen abort left task ${taskId} worktree not-pristine — manual inspection required`,
        'FRESHEN_ABORT_UNCLEAN',
        taskId
      );
    }

    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: {
        action: 'delivery.freshen',
        status: 'conflict',
        base: `origin/${baseBranch}`,
        files: conflictedFiles,
        tip: tipBefore,
        reason: (mergeErr?.stderr || mergeErr?.message || String(mergeErr)).slice(0, 500)
      }
    });
    notifyOperator(
      `freshen:${taskId}`,
      `Task ${taskId}: REAL conflict between its branch and ${baseBranch} — files: ${conflictedFiles.join(', ') || '(unlisted)'}. ` +
        `The branch is untouched (abort verified clean). Reconcile manually (merge ${baseBranch} in the worktree, resolve, commit), then re-drive delivery.`
    );
    // Conflict surfaced, branch pristine, task held at the gate: this job's
    // work is DONE. Recovery is a human act by design.
    return;
  }

  const tipAfter = await git(['rev-parse', 'HEAD']);

  // Re-verify the freshened tree with the same staged engine the normal flow
  // uses. A clean textual merge can still break behavior (semantic conflict);
  // the recorded verifier_exit_code=0 predates this merge and must not carry.
  const startedAt = new Date().toISOString();
  const outcome = await runStagedVerifier(db, taskId, wtRow.path);
  const finishedAt = new Date().toISOString();
  const runId = crypto.randomUUID();

  db.execTransaction(() => {
    db.run(
      `INSERT INTO bureau_verify_runs (
        id, task_id, exit_code, signal, timed_out, duration_ms,
        verify_fixes_before, stdout_tail, stderr_tail, stages, pass_before, pass_after,
        started_at, finished_at,
        actor_role, provider, model, account
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      taskId,
      outcome.exitCode,
      outcome.signal,
      outcome.timedOut ? 1 : 0,
      outcome.durationMs,
      task.verify_fixes,
      outcome.stdoutTail,
      outcome.stderrTail,
      JSON.stringify(outcome.stages),
      outcome.passBefore,
      outcome.passAfter,
      startedAt,
      finishedAt,
      VERIFIER_ATTRIBUTION.actor_role,
      VERIFIER_ATTRIBUTION.provider,
      VERIFIER_ATTRIBUTION.model,
      VERIFIER_ATTRIBUTION.account
    );

    journal(db, {
      kind: 'tool',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      jobId: ctx.job.id,
      detail: {
        action: 'delivery_freshen_reverify',
        run_id: runId,
        exit_code: outcome.exitCode,
        tip_before: tipBefore,
        tip_after: tipAfter,
        stages: outcome.stages.map((s: any) => ({ stage: s.stage, exit_code: s.exit_code, skipped: s.skipped ?? false }))
      }
    });
  });

  if (outcome.exitCode !== 0) {
    // Semantic conflict: the merged tree does not verify. The merge commit
    // STAYS on the branch (rolling back would need `reset` — forbidden; the
    // commit is honest progress toward reconciliation and is never
    // force-pushed). Surface to the operator; the task stays at the gate.
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId,
      detail: {
        action: 'delivery.freshen',
        status: 'reverify_failed',
        exit_code: outcome.exitCode,
        stderr_tail: outcome.stderrTail?.slice(0, 500)
      }
    });
    notifyOperator(
      `freshen:${taskId}`,
      `Task ${taskId} freshened cleanly in git but the merged tree FAILS verification (exit ${outcome.exitCode}) — a semantic conflict. ` +
        `The merge commit stays on the branch; fix the integration in the worktree, then re-drive delivery.`
    );
    return;
  }

  // Verified clean: re-enter the delivery tail at the review gate. The
  // phase4 diff-review records the gate at the NEW tip (its own dedup skips
  // the senior call only when an approved review already stands at exactly
  // this tip); on APPROVE it chains pr.create → pr.merge (pr.create pushes
  // the freshened tip and is idempotent about an already-open PR).
  const inFlight = db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM bureau_jobs
      WHERE task_id = ? AND kind = 'work.diff-review' AND state IN ('pending','running')`,
    taskId
  );
  const reviewJobId =
    inFlight && inFlight.n > 0
      ? undefined
      : enqueueJob(db, { kind: 'work.diff-review', task_id: taskId, payload: { taskId } }).id;

  journal(db, {
    kind: 'system',
    attribution: SYSTEM_ATTRIBUTION,
    taskId,
    jobId: ctx.job.id,
    detail: {
      action: 'delivery.freshen',
      status: 'clean',
      tip_before: tipBefore,
      tip_after: tipAfter,
      reviewJobId: reviewJobId ?? null
    }
  });
  notifyOperator(
    `freshen:${taskId}`,
    `Task ${taskId} branch freshened onto ${baseBranch} and re-verified (exit 0). Code-diff review queued at the new tip (${tipAfter.slice(0, 10)}); delivery chains on APPROVE.`
  );
}
