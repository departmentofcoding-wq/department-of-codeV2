import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AttributionTuple,
  BureauDispatchRow,
  BureauJobRow,
  BureauTaskRow,
  DbConnection
} from '../contract/index.ts';
import { getJuniorProvider } from '../contract/junior-seam.ts';
import { getWorkspaceProviderOverride } from '../contract/workspace-seam.ts';
import { getRepoRoot, getTaskRepoRoot } from '../worktrees/manager.ts';
import { writeJuniorArtifacts, type CapturedArtifacts } from './junior-artifacts.ts';
import { journal } from '../journal/writer.ts';
import { transition } from '../state/machine.ts';

export interface DeadDispatchWorkDetection {
  workDetected: boolean;
  worktreeDirty: boolean;
  dirtyPaths: string[];
  brainWorkDetected: boolean;
  brainDir: string | null;
  artifacts?: CapturedArtifacts;
}

export interface DetectDeadDispatchWorkOptions {
  db: DbConnection;
  taskId: string;
  dispatchId: string;
  dispatchStartedAt?: string;
  junior?: string;
  worktreePath?: string | null;
}

function parseStatusPaths(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function scanDirForNewerFiles(dirPath: string, thresholdMs: number, maxDepth = 4, currentDepth = 0): string[] {
  if (currentDepth > maxDepth || !fs.existsSync(dirPath)) return [];
  const modified: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, ent.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= thresholdMs) {
          modified.push(fullPath);
        }
        if (ent.isDirectory()) {
          modified.push(...scanDirForNewerFiles(fullPath, thresholdMs, maxDepth, currentDepth + 1));
        }
      } catch {}
    }
  } catch {}
  return modified;
}

/**
 * Snapshots the worktree dirty state and inspects the junior provider's brain dir
 * for artifacts modified since the dispatch began.
 */
export async function detectDeadDispatchWork(
  opts: DetectDeadDispatchWorkOptions
): Promise<DeadDispatchWorkDetection> {
  const { db, taskId, dispatchStartedAt, junior } = opts;
  const repoRoot = getTaskRepoRoot(db, taskId, getRepoRoot());
  const thresholdMs = dispatchStartedAt ? new Date(dispatchStartedAt).getTime() : 0;

  let worktreePath = opts.worktreePath;
  if (!worktreePath) {
    const wsProvider = getWorkspaceProviderOverride();
    if (wsProvider) {
      try {
        const handle = await wsProvider.getWorkspaceHandle(db, taskId);
        worktreePath = handle.path;
      } catch {}
    }
  }
  if (!worktreePath) {
    worktreePath = path.join(repoRoot, '.bureau-worktrees', taskId);
  }

  let worktreeDirty = false;
  let dirtyPaths: string[] = [];

  if (worktreePath && fs.existsSync(worktreePath)) {
    try {
      const gitOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const parsed = parseStatusPaths(gitOut);
      if (parsed.length > 0) {
        worktreeDirty = true;
        dirtyPaths = parsed;
      }
    } catch {
      // Non-git worktree directory: inspect file mtimes
      const newer = scanDirForNewerFiles(worktreePath, thresholdMs);
      if (newer.length > 0) {
        worktreeDirty = true;
        dirtyPaths = newer.map(p => path.relative(worktreePath!, p));
      }
    }
  }

  let brainWorkDetected = false;
  let brainDir: string | null = null;
  let artifacts: CapturedArtifacts | undefined;

  try {
    const provider = getJuniorProvider();
    brainDir = provider.brainDir ? provider.brainDir(junior) : null;
    if (brainDir && fs.existsSync(brainDir)) {
      const subdirs = fs
        .readdirSync(brainDir, { withFileTypes: true })
        .filter(ent => ent.isDirectory())
        .map(ent => path.join(brainDir!, ent.name));

      const candidateDirs: Array<{ dir: string; newestMtime: number }> = [];

      for (const sub of subdirs) {
        let newestMtime = 0;
        try {
          newestMtime = fs.statSync(sub).mtimeMs;
        } catch {}
        const newerFiles = scanDirForNewerFiles(sub, thresholdMs);
        if (newestMtime >= thresholdMs || newerFiles.length > 0) {
          candidateDirs.push({ dir: sub, newestMtime });
        }
      }

      if (candidateDirs.length > 0) {
        candidateDirs.sort((a, b) => b.newestMtime - a.newestMtime);
        const best = candidateDirs[0].dir;
        brainWorkDetected = true;

        const readFile = (filename: string): string | undefined => {
          const p = path.join(best, filename);
          return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
        };

        const plan = readFile('implementation_plan.md') || readFile('plan.md');
        const walkthrough = readFile('walkthrough.md');
        const reply = readFile('reply.md');
        let fullOutput =
          readFile(path.join('.system_generated', 'logs', 'transcript_full.jsonl')) ||
          readFile(path.join('.system_generated', 'logs', 'transcript.jsonl')) ||
          readFile('transcript.md');

        artifacts = {
          junior,
          plan,
          walkthrough,
          reply,
          fullOutput
        };
      }
    }
  } catch {}

  return {
    workDetected: worktreeDirty || brainWorkDetected,
    worktreeDirty,
    dirtyPaths,
    brainWorkDetected,
    brainDir,
    artifacts
  };
}

/**
 * Reconciles work left by a terminally failed junior.dispatch job.
 * Transitions task to 'blocked' if uncommitted or brain work is found.
 */
export async function reconcileDeadDispatchWork(
  db: DbConnection,
  job: BureauJobRow,
  error: string
): Promise<boolean> {
  if (!job.task_id) return false;

  const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', job.task_id);
  if (!task || task.state !== 'claimed') return false;

  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(job.payload || '{}');
  } catch {}

  let dispatch: BureauDispatchRow | undefined;
  if (payload.dispatchId) {
    dispatch = db.get<BureauDispatchRow>('SELECT * FROM bureau_dispatches WHERE id = ?', payload.dispatchId);
  }
  if (!dispatch) {
    dispatch = db.get<BureauDispatchRow>(
      'SELECT * FROM bureau_dispatches WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      task.id
    );
  }

  const dispatchId = dispatch?.id ?? payload.dispatchId ?? job.id;
  const dispatchStartedAt = dispatch?.created_at ?? job.created_at;
  const junior = dispatch?.provider === 'antigravity'
    ? (task.assigned_junior ?? payload.junior ?? 'A')
    : (payload.junior ?? task.assigned_junior ?? 'A');

  // R1 (2026-09-08 incident): never salvage-and-block while a SIBLING dispatch
  // for the same task is still live. The detection below scans the SHARED
  // per-task worktree and the per-junior brain dir, so a terminally failed
  // DUPLICATE dispatch sees the LIVE sibling's in-flight work and would block
  // the task mid-implementation (dispatch 383b9e39's lease-conflict death
  // blocked task 9cabfabd while its real dispatch a9c80b20 was still running).
  // The live sibling drives the task to completion; nothing is stranded.
  const liveSiblings = db.all<{ id: string }>(
    `SELECT id FROM bureau_dispatches WHERE task_id = ? AND id <> ? AND status = 'running'`,
    task.id,
    dispatchId
  );
  if (liveSiblings.length > 0) {
    journal(db, {
      kind: 'guardrail',
      attribution: {
        actor_role: 'system',
        provider: 'deterministic',
        model: 'core',
        account: null
      },
      taskId: task.id,
      workUuid: task.work_uuid,
      jobId: job.id,
      detail: {
        action: 'dead_dispatch_skipped_live_sibling',
        deadDispatchId: dispatchId,
        liveDispatchIds: liveSiblings.map((s) => s.id),
        error
      }
    });
    return false;
  }

  const detection = await detectDeadDispatchWork({
    db,
    taskId: task.id,
    dispatchId,
    dispatchStartedAt,
    junior
  });

  if (!detection.workDetected) {
    return false;
  }

  const repoRoot = getTaskRepoRoot(db, task.id, getRepoRoot());

  let fullOutput = detection.artifacts?.fullOutput;
  if (!fullOutput && !detection.artifacts?.plan && !detection.artifacts?.walkthrough) {
    fullOutput = [
      `# Dead-dispatch work salvage (${new Date().toISOString()})`,
      '',
      `Terminal failure encountered for dispatch ${dispatchId} on task ${task.id}.`,
      `Error: ${error}`,
      `Worktree dirty paths: ${detection.dirtyPaths.join(', ') || 'none'}`,
      `Brain work detected: ${detection.brainWorkDetected ? 'yes' : 'no'}`
    ].join('\n');
  }

  const written = writeJuniorArtifacts(
    task.id,
    dispatchId,
    {
      junior,
      plan: detection.artifacts?.plan,
      walkthrough: detection.artifacts?.walkthrough,
      fullOutput,
      reply: detection.artifacts?.reply
    },
    repoRoot
  );

  const systemAttr: AttributionTuple = {
    actor_role: 'system',
    provider: 'deterministic',
    model: 'core',
    account: null
  };

  journal(db, {
    kind: 'guardrail',
    attribution: systemAttr,
    taskId: task.id,
    workUuid: task.work_uuid,
    jobId: job.id,
    detail: {
      action: 'dead_dispatch_work_detected',
      dispatchId,
      worktreeDirty: detection.worktreeDirty,
      dirtyPaths: detection.dirtyPaths,
      brainWorkDetected: detection.brainWorkDetected,
      brainDir: detection.brainDir,
      artifactsWritten: written.files,
      error
    }
  });

  transition(db, task.id, 'blocked', systemAttr, {
    action: 'dead_dispatch_work_detected',
    reason: `Dead dispatch ${dispatchId} with uncommitted/brain work: ${error}`
  });

  return true;
}
