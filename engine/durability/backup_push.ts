import type { AttributionTuple, JobContext } from '../contract/types.ts';
import { getBackupProvider } from '../contract/backup-seam.ts';
import { journal } from '../journal/writer.ts';

const SYSTEM_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

export class BackupPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupPushError';
  }
}

export async function handleBackupPush(ctx: JobContext): Promise<void> {
  const { db, payload } = ctx;
  let remote = 'origin';
  let branch = 'main';

  const target = payload?.target;
  if (typeof target === 'string' && target.trim().length > 0) {
    const trimmed = target.trim();
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx !== -1) {
      remote = trimmed.slice(0, slashIdx);
      // Note: split on first '/' only. Slash-bearing branch names (e.g. wt/feature-name) are not supported in target strings; department backs up 'main'.
      branch = trimmed.slice(slashIdx + 1);
    } else {
      remote = trimmed;
    }
  }

  // N9: a task in a non-dept project must be backed up against THAT project's
  // repo. Resolve it from the task's project (bureau_projects.path_to_repo) and
  // root the provider there; a dept task (project_id null) or a project with no
  // recorded path falls back to the default dept repo root — unchanged.
  let repoRoot: string | undefined;
  const backupTaskId = ctx.job.task_id;
  if (backupTaskId) {
    const task = db.get<{ project_id: string | null }>(
      'SELECT project_id FROM bureau_tasks WHERE id = ?',
      backupTaskId
    );
    if (task?.project_id) {
      const proj = db.get<{ path_to_repo: string }>(
        'SELECT path_to_repo FROM bureau_projects WHERE id = ?',
        task.project_id
      );
      if (proj?.path_to_repo) {
        repoRoot = proj.path_to_repo;
      }
    }
  }

  const provider = getBackupProvider(repoRoot);

  // The commit this backup exists to guarantee on the remote (the merge/tip
  // commit pr.merge threads through the payload). When present and the remote
  // already contains it, the backup's obligation is DISCHARGED by proof, not
  // by a push — pr.merge merges PRs on GitHub, so origin is ahead and pushing
  // local main was structurally dead (`! [rejected] fetch first`, four dead
  // backup.push jobs 2026-08-26→28).
  const commit = typeof payload?.commit === 'string' && payload.commit.length > 0 ? payload.commit : null;

  // 1. Sync remote-tracking refs. Best-effort: a fetch failure degrades to
  //    the legacy push path, it never blocks the guarantee.
  if (provider.fetch) {
    try {
      await provider.fetch(remote);
    } catch (err: any) {
      journal(db, {
        kind: 'system',
        attribution: SYSTEM_ATTRIBUTION,
        taskId: ctx.job.task_id ?? undefined,
        detail: { action: 'backup.push', status: 'fetch_warning', error: String(err?.message ?? err) }
      });
    }
  }

  // 2. Reconcile local main with the (possibly server-side-advanced) remote:
  //    fast-forward when possible so local stops diverging from origin after
  //    every delivery. Best-effort and journaled — divergence is the
  //    operator's to reconcile, never silently forced.
  if (provider.fastForwardLocal) {
    try {
      await provider.fastForwardLocal(remote, branch);
    } catch (err: any) {
      journal(db, {
        kind: 'system',
        attribution: SYSTEM_ATTRIBUTION,
        taskId: ctx.job.task_id ?? undefined,
        detail: { action: 'backup.push', status: 'fast_forward_warning', error: String(err?.message ?? err) }
      });
    }
  }

  // 3. If the remote already contains the commit (the normal post-PR-merge
  //    case), record the readback proof and finish — no push is needed and a
  //    push would only be rejected.
  if (commit && provider.remoteContains) {
    let contained = false;
    try {
      contained = await provider.remoteContains(remote, branch, commit);
    } catch (err: any) {
      journal(db, {
        kind: 'system',
        attribution: SYSTEM_ATTRIBUTION,
        taskId: ctx.job.task_id ?? undefined,
        detail: { action: 'backup.push', status: 'containment_check_warning', error: String(err?.message ?? err) }
      });
    }
    if (contained) {
      const verifiedTip = await provider.getRemoteTip(remote, branch);
      journal(db, {
        kind: 'system',
        attribution: SYSTEM_ATTRIBUTION,
        taskId: ctx.job.task_id ?? undefined,
        detail: {
          action: 'backup.push',
          status: 'already_on_remote',
          commit,
          remoteTip: verifiedTip
        }
      });
      return;
    }
  }

  // 4. Legacy path (and the genuinely-local-ahead case): push local, then the
  //    anti-false-claim readback — remote tip must match local tip.
  const localTip = await provider.getLocalTip(branch);
  await provider.push(remote, branch);
  const remoteTip = await provider.getRemoteTip(remote, branch);

  // Anti-false-claim rule: verify remote tip matches local tip
  if (remoteTip !== localTip) {
    const errorMsg = `Remote tip mismatch for ${remote}/${branch}: local=${localTip}, remote=${remoteTip}`;
    journal(db, {
      kind: 'guardrail',
      attribution: SYSTEM_ATTRIBUTION,
      taskId: ctx.job.task_id ?? undefined,
      detail: {
        action: 'backup.push',
        status: 'mismatch',
        localTip,
        remoteTip,
        reason: errorMsg
      }
    });
    throw new BackupPushError(errorMsg);
  }

  journal(db, {
    kind: 'system',
    attribution: SYSTEM_ATTRIBUTION,
    taskId: ctx.job.task_id ?? undefined,
    detail: {
      action: 'backup.push',
      status: 'success',
      localTip,
      remoteTip
    }
  });
}
