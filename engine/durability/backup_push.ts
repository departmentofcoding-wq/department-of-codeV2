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
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      remote = parts[0];
      branch = parts.slice(1).join('/');
    } else {
      remote = trimmed;
    }
  }

  const provider = getBackupProvider();

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
