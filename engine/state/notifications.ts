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

/**
 * Triggers task status change notifications for subscribers and configured Ntfy endpoint.
 * Called on terminal/critical state transitions ('blocked' / 'done').
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
    const serverUrlRow = db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      'ntfy_server_url'
    );
    const topicRow = db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      'ntfy_topic'
    );

    const topic = topicRow?.value?.trim();
    if (topic) {
      const client = new NtfyClient({
        serverUrl: serverUrlRow?.value,
        topic
      });
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
          topic,
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
