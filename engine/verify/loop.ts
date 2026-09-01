import crypto from 'node:crypto';
import type { AttributionTuple, BureauTaskRow, DbConnection, VerifyStageResult } from '../contract/index.ts';
import { VERIFIER_ATTRIBUTION } from '../contract/constants.ts';
import { enqueueJob } from '../jobs/jobs.ts';
import { journal } from '../journal/writer.ts';
import { transition } from '../state/machine.ts';
import { notifyOperator } from '../state/notifications.ts';
import { assignJunior, JUNIOR_COMPLETION_INSTRUCTION } from '../harness/antigravity.ts';
import type { VerifyRunResult } from './verifier.ts';

export interface VerifyOutcomeResult {
  isSuccess: boolean;
  isSendback: boolean;
}

export interface VerifyOutcomeOptions {
  /**
   * The current worktree tip commit, read by the caller BEFORE the finalization
   * transaction (a git subprocess must not run inside `execTransaction`). Used
   * only on the success path to detect a stale standing approval (N1/defect 2).
   * Undefined when the caller could not read it (e.g. the fake workspace
   * provider in unit tests) — the stale-approval guard is then skipped, so
   * behaviour is identical to before this fix.
   */
  tip?: string;
  ceiling?: number;
  isSendback?: boolean;
  junior?: string;
  juniorModel?: string;
  folder?: string;
  seniorId?: string;
  seniorModel?: string;
}

/**
 * Reads the verify fixes ceiling from bureau_meta with default fallback of 2.
 */
export function readVerifyCeiling(db: DbConnection): number {
  const ceilingRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    'verify:fixes:ceiling'
  );
  const rawCeiling = ceilingRow ? parseInt(ceilingRow.value, 10) : 2;
  return Number.isFinite(rawCeiling) && rawCeiling > 0 ? rawCeiling : 2;
}

/**
 * Predicate determining whether a verifier failure triggers a fix sendback round.
 * True iff outcome is not successful (non-zero exit or timed out) and fixes budget < ceiling.
 */
export function isVerifyFixSendback(
  task: Pick<BureauTaskRow, 'verify_fixes'>,
  outcome: VerifyRunResult,
  ceiling: number
): boolean {
  const isSuccess = outcome.exitCode === 0 && !outcome.timedOut;
  return !isSuccess && task.verify_fixes < ceiling;
}

/**
 * Builds the fix prompt given to the junior on a verifier failure:
 * verifier failure summary + full task specification + completion instruction.
 */
export function buildVerifyFixPrompt(
  task: BureauTaskRow,
  outcome: VerifyRunResult & { stages?: VerifyStageResult[] },
  round: number,
  ceiling: number,
  projectInfo?: { name: string; path: string }
): string {
  const failedStages = (outcome.stages || []).filter((s) => s.exit_code !== 0 && !s.skipped);
  const stageSummary =
    failedStages.length > 0
      ? failedStages.map((s) => `Stage '${s.stage}' failed (exit code ${s.exit_code})`).join('\n')
      : `Verifier failed (exit code ${outcome.exitCode}${outcome.timedOut ? ', timed out' : ''})`;


  return (
    `The verifier failed on your worktree (verify-fix round ` +
    `${round} of at most ${ceiling}). Fix EVERY issue reported by the verifier below, ` +
    `then finish with an updated walkthrough summarizing what you changed, the test ` +
    `results, and the verification you ran — the senior will re-review your changes before re-verifying.\n\n` +
    `===== VERIFIER FAILURE SUMMARY =====\n` +
    `Exit Code: ${outcome.exitCode}${outcome.timedOut ? ' (timed out)' : ''}\n` +
    `Failed Stages:\n${stageSummary}\n` +
    (outcome.stdoutTail ? `\nStdout Tail:\n${outcome.stdoutTail.trim()}\n` : '') +
    (outcome.stderrTail ? `\nStderr Tail:\n${outcome.stderrTail.trim()}\n` : '') +
    `\n===== TASK =====\n` +
    `TITLE: ${task.title}\n` +
    (projectInfo ? `PROJECT: ${projectInfo.name} (${projectInfo.path})\n` : '') +
    (task.intent ? `INTENT: ${task.intent}\n` : '') +
    (task.spec ? `SPEC: ${task.spec}\n` : '') +
    (task.acceptance ? `ACCEPTANCE: ${task.acceptance}\n` : '') +
    (task.verify_cmd ? `VERIFY_CMD: ${task.verify_cmd}\n` : '') +
    `\n${JUNIOR_COMPLETION_INSTRUCTION}`
  );
}

/**
 * Executes all synchronous database state transitions and job enqueues for a verifier run outcome.
 * MUST be invoked inside the finalization transaction in executeVerifyRunJob.
 */
export function handleVerifyOutcome(
  db: DbConnection,
  taskId: string,
  outcome: VerifyRunResult & { stages?: VerifyStageResult[] },
  attribution: AttributionTuple = VERIFIER_ATTRIBUTION,
  opts: VerifyOutcomeOptions = {}
): VerifyOutcomeResult {
  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found for verification outcome handling`);
  }

  const ceiling = opts.ceiling ?? readVerifyCeiling(db);
  const isSendback = opts.isSendback ?? isVerifyFixSendback(task, outcome, ceiling);
  const isSuccess = outcome.exitCode === 0 && !outcome.timedOut;

  if (isSuccess) {
    db.run('UPDATE bureau_tasks SET verifier_exit_code = 0 WHERE id = ?', taskId);

    // N1 / defect 2: never reach the delivery gate on a STALE approval. A
    // `verify-failure-sendback` checkpoint commits whatever is dirty in the
    // worktree (e.g. an out-of-band junior still editing — N0), which can move
    // the branch tip PAST the commit the senior approved. If that happens, a
    // later passing verify would land at `needs-review` while the standing
    // approval still points at the old commit — `pr.create` then refuses on
    // `reviewed_commit != tip` and the task STRANDS looking delivery-ready (the
    // b55e2fda scar, which needed a manual re-review). Instead, re-enter senior
    // work review at the new tip so the flow self-heals. Skipped when `tip` is
    // unreadable (fake provider) — identical to pre-fix behaviour.
    if (opts.tip) {
      const approval = db.get<{ reviewed_commit: string }>(
        `SELECT reviewed_commit FROM bureau_work_reviews
         WHERE task_id = ? AND verdict = 'approved' AND reviewed_commit IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        taskId
      );
      if (approval && approval.reviewed_commit !== opts.tip) {
        // Back into the work loop (verifying -> claimed is already legal — the
        // sendback path uses it) and re-review at the moved tip.
        transition(db, taskId, 'claimed', attribution, {
          action: 'verify_passed_stale_approval',
          reviewed_commit: approval.reviewed_commit,
          tip: opts.tip
        });
        // Self-heal via the live review path. Idempotent: only skip if another
        // re-review (work.cycle) is ALREADY queued for this task. The check is
        // deliberately narrow — it must NOT include verify.run, because this
        // runs inside the current verify.run job's own transaction (before
        // completeJob), so that job is still live and would self-match, suppress
        // the enqueue, and strand the task at `claimed` with no work.cycle.
        const inFlight = db.get<{ n: number }>(
          `SELECT COUNT(*) n FROM bureau_jobs
           WHERE task_id = ? AND kind = 'work.cycle'
           AND state IN ('pending','running')`,
          taskId
        );
        if (!inFlight || inFlight.n === 0) {
          // Junior pinned explicitly (deterministic policy — same junior every
          // phase of this task) so the re-review's fix dispatch can't flip to
          // another task's junior under concurrency (N3).
          enqueueJob(db, {
            kind: 'work.cycle',
            task_id: taskId,
            payload: { taskId, junior: assignJunior({ taskId }) }
          });
        }
        journal(db, {
          kind: 'guardrail',
          attribution,
          taskId,
          detail: {
            reason: 'verify_passed_stale_approval',
            reviewed_commit: approval.reviewed_commit,
            tip: opts.tip
          }
        });
        notifyOperator(
          taskId,
          `verify passed but the standing approval is stale ` +
            `(reviewed ${approval.reviewed_commit.slice(0, 8)} != tip ${opts.tip.slice(0, 8)}) ` +
            `— re-reviewing at the new tip before delivery`
        );
        return { isSuccess: false, isSendback: false };
      }
    }

    transition(db, taskId, 'needs-review', attribution, {
      action: 'verify_passed',
      duration_ms: outcome.durationMs
    });
    return { isSuccess: true, isSendback: false };
  }

  // Failure path: check verify_fixes budget ceiling
  if (isSendback) {
    // Send-back loop: atomic increment, transition to claimed, and enqueue junior.dispatch fix round
    const newFixes = task.verify_fixes + 1;
    db.run('UPDATE bureau_tasks SET verify_fixes = ? WHERE id = ?', newFixes, taskId);
    transition(db, taskId, 'claimed', attribution, {
      action: 'verify_failed_sendback',
      verify_fixes: newFixes,
      ceiling,
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut
    });

    let folder = opts.folder;
    let projectInfo: { name: string; path: string } | undefined;
    if (task.project_id) {
      const proj = db.get<{ name: string; path_to_repo: string }>(
        'SELECT name, path_to_repo FROM bureau_projects WHERE id = ?',
        task.project_id
      );
      if (proj) {
        projectInfo = { name: proj.name, path: proj.path_to_repo };
        if (!folder) {
          folder = proj.path_to_repo;
        }
      }
    }

    const fixPrompt = buildVerifyFixPrompt(task, outcome, newFixes, ceiling, projectInfo);
    const junior = (opts.junior || assignJunior({ taskId })).toUpperCase();
    const juniorModel = opts.juniorModel ?? 'unspecified';
    const dispatchId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, account, status, created_at)
       VALUES (?, ?, ?, 'junior-engineer', 'antigravity', ?, NULL, 'pending', ?)`,
      dispatchId,
      task.id,
      task.work_uuid,
      juniorModel,
      nowIso
    );

    enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: taskId,
      payload: {
        dispatchId,
        prompt: fixPrompt,
        junior,
        freshConversation: false,
        chainWorkReview: true,
        ...(juniorModel !== 'unspecified' ? { model: juniorModel } : {}),
        ...(folder ? { folder } : {}),
        ...(opts.seniorId ? { workSeniorId: opts.seniorId } : {}) as any,
        ...(opts.seniorModel ? { workSeniorModel: opts.seniorModel } : {}) as any
      },
      max_attempts: 1
    });

    return { isSuccess: false, isSendback: true };
  } else {
    // Budget ceiling reached: block task and notify operator
    transition(db, taskId, 'blocked', attribution, {
      action: 'verify_ceiling_reached',
      verify_fixes: task.verify_fixes,
      ceiling,
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut
    });

    journal(db, {
      kind: 'guardrail',
      attribution,
      taskId,
      detail: {
        reason: 'verify_fixes ceiling reached',
        verify_fixes: task.verify_fixes,
        ceiling
      }
    });

    notifyOperator(taskId, 'verify_fixes ceiling reached');
    return { isSuccess: false, isSendback: false };
  }
}

