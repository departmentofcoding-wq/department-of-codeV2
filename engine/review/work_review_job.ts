import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type {
  AttributionTuple,
  BureauTaskRow,
  BureauWorktreeRow,
  JobContext
} from '../contract/types.ts';
import { getWorkspaceProvider } from '../contract/workspace-seam.ts';
import { journal } from '../journal/writer.ts';
import { callModel } from '../llm/call_model.ts';
import { getBranchTipCommit } from '../worktrees/commit.ts';

export const SENIOR_PRECONDITION_ATTRIBUTION: AttributionTuple = {
  actor_role: 'senior-engineer',
  provider: 'deterministic',
  model: 'preconditions',
  account: null
};

export interface WorkPreconditionResult {
  ok: boolean;
  missing: string[];
}

export async function evaluateWorkPreconditions(
  ctx: JobContext,
  task: BureauTaskRow,
  worktree: BureauWorktreeRow,
  worktreePath: string
): Promise<WorkPreconditionResult> {
  const missing: string[] = [];

  // 1. Task state must be 'needs-review'
  if (task.state !== 'needs-review') {
    missing.push(`task state must be needs-review (current=${task.state})`);
  }

  // 2. Verifier exit code must be 0
  if (task.verifier_exit_code !== 0) {
    missing.push(`verifier exit code must be 0 (current=${task.verifier_exit_code ?? 'null'})`);
  }

  // 3. Worktree status ready AND provider.isClean()
  const provider = getWorkspaceProvider();
  let cleanInSeam = false;
  try {
    cleanInSeam = await provider.isClean(ctx.db, task.id);
  } catch {
    cleanInSeam = false;
  }

  if (worktree.status !== 'ready' || !cleanInSeam) {
    missing.push(`worktree status must be clean/ready (status=${worktree.status}, cleanInSeam=${cleanInSeam})`);
  }

  // 4. Walkthrough claims present inside task worktree filesystem
  const walkthroughPath = path.join(worktreePath, 'walkthrough.md');
  const docsReviewsDir = path.join(worktreePath, 'docs', 'reviews');
  let hasWalkthrough = fs.existsSync(walkthroughPath);
  if (!hasWalkthrough && fs.existsSync(docsReviewsDir)) {
    try {
      const files = fs.readdirSync(docsReviewsDir);
      hasWalkthrough = files.some((f) => f.endsWith('.md'));
    } catch {
      hasWalkthrough = false;
    }
  }

  if (!hasWalkthrough) {
    missing.push('walkthrough file in task worktree (walkthrough.md or docs/reviews/*.md)');
  }

  // 5. Mutation evidence appended inside task worktree filesystem
  const mutationEvidencePath = path.join(worktreePath, 'docs', 'mutation-evidence-phase4.md');
  let hasMutationEvidence = false;
  if (fs.existsSync(mutationEvidencePath)) {
    try {
      const content = fs.readFileSync(mutationEvidencePath, 'utf8');
      hasMutationEvidence = content.length > 50 && content.toLowerCase().includes('guard');
    } catch {
      hasMutationEvidence = false;
    }
  }

  if (!hasMutationEvidence) {
    missing.push('mutation evidence in task worktree (docs/mutation-evidence-phase4.md)');
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

export interface SeniorReviewWorkPayload {
  taskId: string;
}

export async function handleSeniorReviewWork(ctx: JobContext): Promise<void> {
  const payload = ctx.payload as SeniorReviewWorkPayload;
  if (!payload || !payload.taskId) {
    throw new Error("senior.review-work job missing required payload 'taskId'");
  }

  const task = ctx.db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', payload.taskId);
  if (!task) {
    throw new Error(`Task '${payload.taskId}' not found in bureau_tasks`);
  }

  const worktree = ctx.db.get<BureauWorktreeRow>(
    'SELECT * FROM bureau_worktrees WHERE task_id = ?',
    task.id
  );
  if (!worktree) {
    throw new Error(`Worktree for task '${task.id}' not found in bureau_worktrees`);
  }

  const provider = getWorkspaceProvider();
  const handle = await provider.getWorkspaceHandle(ctx.db, task.id);
  const worktreePath = handle?.path ?? worktree.path;

  // A-5: Read exact branch tip commit hash at review time
  const tipCommit = await getBranchTipCommit(ctx.db, task.id);

  // A-4: Evaluate Tougher Preconditions (Zero token cost gate)
  const preconditions = await evaluateWorkPreconditions(ctx, task, worktree, worktreePath);
  const nowIso = new Date().toISOString();

  if (!preconditions.ok) {
    const comments = `Preconditions failed: ${preconditions.missing.join(', ')}`;
    const reviewId = crypto.randomUUID();

    journal(ctx.db, {
      kind: 'guardrail',
      attribution: SENIOR_PRECONDITION_ATTRIBUTION,
      taskId: task.id,
      jobId: ctx.job.id,
      detail: {
        action: 'work_preconditions_refusal',
        missing: preconditions.missing
      }
    });

    ctx.db.execTransaction(() => {
      ctx.db.run(
        `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
         VALUES (?, ?, ?, 'phase4', ?, 'rejected', ?, ?, 'senior-engineer', 'deterministic', 'preconditions', NULL, ?)`,
        reviewId,
        task.id,
        task.work_uuid,
        task.cycles,
        comments,
        tipCommit,
        nowIso
      );

      journal(ctx.db, {
        kind: 'review',
        attribution: SENIOR_PRECONDITION_ATTRIBUTION,
        taskId: task.id,
        jobId: ctx.job.id,
        detail: {
          verdict: 'rejected',
          comments,
          reviewed_commit: tipCommit
        }
      });
    });

    return;
  }

  // Preconditions passed -> Read diff over worktree
  let diffText = '';
  try {
    diffText = execSync(`git diff ${worktree.base_commit}..HEAD`, {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    diffText = 'git diff unavailable';
  }

  const systemPrompt =
    'You are a Senior Engineer reviewing work (code diff & walkthrough) for a task in the bureau. ' +
    'Evaluate the diff against task requirements. ' +
    'Respond with a JSON object containing "verdict" ("approved" or "amend") and "comments" (string).';

  const userPrompt =
    `Task Title: ${task.title}\n` +
    `Intent: ${task.intent ?? 'N/A'}\n` +
    `Spec: ${task.spec ?? 'N/A'}\n` +
    `Acceptance: ${task.acceptance ?? 'N/A'}\n` +
    `Reviewed Commit: ${tipCommit}\n\n` +
    `Git Diff:\n${diffText.slice(0, 4000)}\n\n` +
    'Provide review decision in JSON format: {"verdict": "approved" | "amend", "comments": "feedback"}';

  const completion = await callModel(
    ctx.db,
    'senior-engineer',
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    undefined,
    {
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: ctx.job.id,
      signal: ctx.signal
    }
  );

  let verdict: 'approved' | 'amend' = 'amend';
  let comments = 'Unparseable Senior model response; defaulting to amend';

  try {
    const parsed = JSON.parse(completion.text ?? '{}');
    if (parsed.verdict === 'approved') {
      verdict = 'approved';
    } else if (parsed.verdict === 'amend') {
      verdict = 'amend';
    }
    if (typeof parsed.comments === 'string' && parsed.comments.length > 0) {
      comments = parsed.comments;
    }
  } catch {
    if (completion.text && completion.text.length > 0) {
      comments = completion.text;
    }
  }

  const modelAttribution: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: completion.provider ?? 'mock',
    model: completion.model ?? 'mock-model',
    account: (completion as any).account ?? null
  };

  const reviewId = crypto.randomUUID();

  ctx.db.execTransaction(() => {
    ctx.db.run(
      `INSERT INTO bureau_work_reviews (id, task_id, work_uuid, phase, round, verdict, comments, reviewed_commit, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, 'phase4', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reviewId,
      task.id,
      task.work_uuid,
      task.cycles,
      verdict,
      comments,
      tipCommit,
      modelAttribution.actor_role,
      modelAttribution.provider,
      modelAttribution.model,
      modelAttribution.account,
      nowIso
    );

    journal(ctx.db, {
      kind: 'review',
      attribution: modelAttribution,
      taskId: task.id,
      jobId: ctx.job.id,
      detail: {
        verdict,
        comments,
        reviewed_commit: tipCommit
      }
    });
  });
}
