import type { DbConnection } from '../contract/types.ts';
import { NtfyClient } from '../notifications/ntfy.ts';
import { journal } from '../journal/writer.ts';

export interface OperatorNotifier {
  notifyOperator(targetId: string, reason: string): void;
}

export function notifyOperator(targetId: string, reason: string): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'WARN',
      msg: 'operator_notified',
      targetId,
      reason
    })
  );
}

export const defaultNotifier: OperatorNotifier = {
  notifyOperator(targetId: string, reason: string): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'WARN',
        msg: 'operator_notified',
        targetId,
        reason
      })
    );
  }
};

export interface TaskStateChangeEvent {
  taskId: string;
  title: string;
  state: string;
  reason?: string;
}

export type TaskStateSubscriber = (event: TaskStateChangeEvent) => void | Promise<void>;

const subscribers = new Set<TaskStateSubscriber>();

export function subscribeTaskStateChange(subscriber: TaskStateSubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function clearTaskStateSubscribers(): void {
  subscribers.clear();
}

const SYSTEM_ATTR = {
  actor_role: 'system' as const,
  provider: 'deterministic',
  model: 'core',
  account: null
};

/** Read the persisted ntfy server URL + topic from bureau_meta. */
export function readNtfyConfig(db: DbConnection): { serverUrl: string | undefined; topic: string } {
  const serverUrlRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    'ntfy_server_url'
  );
  const topicRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    'ntfy_topic'
  );
  return { serverUrl: serverUrlRow?.value, topic: topicRow?.value?.trim() || '' };
}

/**
 * Triggers task status change notifications for subscribers and configured Ntfy endpoint.
 * Fires on entry to any state in NOTIFYING_TASK_STATES (see notifications/events.ts):
 * task started (claimed), needs-review, blocked, failed, and done.
 */
export async function notifyTaskStateChange(
  db: DbConnection,
  event: TaskStateChangeEvent
): Promise<void> {
  // 1. Notify any in-memory subscribers
  for (const subscriber of subscribers) {
    try {
      await subscriber(event);
    } catch (err: any) {
      console.error(`Error in task state subscriber: ${err?.message || err}`);
    }
  }

  // 2. Query persisted Ntfy settings from bureau_meta
  try {
    const { serverUrl, topic } = readNtfyConfig(db);
    if (topic) {
      const client = new NtfyClient({ serverUrl, topic });
      const success = await client.sendNotification({
        taskId: event.taskId,
        title: event.title,
        state: event.state,
        reason: event.reason
      });

      journal(db, {
        kind: 'system',
        attribution: {
          actor_role: 'system',
          provider: 'deterministic',
          model: 'core',
          account: null
        },
        taskId: event.taskId,
        detail: {
          action: 'ntfy_notification',
          state: event.state,
          // Record only THAT a topic was configured, never its value — an ntfy
          // topic is the address anyone can publish/subscribe to, so keep it out of
          // the journal (mirrors the settings-save span's 'configured'/'empty').
          topicConfigured: true,
          success
        }
      });
    }
  } catch (err: any) {
    journal(db, {
      kind: 'guardrail',
      attribution: {
        actor_role: 'system',
        provider: 'deterministic',
        model: 'core',
        account: null
      },
      taskId: event.taskId,
      detail: {
        action: 'ntfy_notification_failed',
        error: err?.message || String(err)
      }
    });
  }
}

/**
 * Sends a "department is online" push when the console/runner starts. Best-effort:
 * a no-op if no ntfy topic is configured; never throws into the caller's startup.
 */
export async function notifyDepartmentOnline(db: DbConnection): Promise<boolean> {
  try {
    const { serverUrl, topic } = readNtfyConfig(db);
    if (!topic) return false;
    const client = new NtfyClient({ serverUrl, topic });
    const success = await client.sendMessage({
      title: '[Department of Code] Online',
      message: 'The department is online — the console and background runner have started.',
      priority: 'default',
      tags: ['green_circle', 'office']
    });
    journal(db, {
      kind: 'system',
      attribution: SYSTEM_ATTR,
      detail: { action: 'ntfy_department_online', topicConfigured: true, success }
    });
    return success;
  } catch {
    return false;
  }
}

/**
 * Sends a manual test push from the Settings panel so the operator can confirm
 * delivery to their phone. Returns whether a topic is configured and whether the
 * send succeeded — surfaced to the console, never throws.
 */
export async function sendTestNotification(
  db: DbConnection
): Promise<{ configured: boolean; sent: boolean }> {
  const { serverUrl, topic } = readNtfyConfig(db);
  if (!topic) {
    return { configured: false, sent: false };
  }
  const client = new NtfyClient({ serverUrl, topic });
  const sent = await client.sendMessage({
    title: '[Department of Code] Test notification',
    message: 'This is a test push from the Operator Console. If you can read this, ntfy is wired up correctly. ✅',
    priority: 'default',
    tags: ['bell', 'test_tube']
  });
  journal(db, {
    kind: 'human',
    attribution: {
      actor_role: 'human-operator',
      provider: 'human',
      model: 'operator',
      account: 'operator'
    },
    detail: { action: 'ntfy_test', topicConfigured: true, success: sent }
  });
  return { configured: true, sent };
}
