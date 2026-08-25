/**
 * The catalog of events that send an ntfy push — the single source of truth for
 * BOTH the trigger code (which task states fire a notification) AND the console
 * Settings list ("what sends notifications"). Add an event here and it lights up
 * in both places; the two can never drift.
 */

export interface NotificationEvent {
  /** Stable identifier. */
  key: string;
  /** Human label shown in the Settings list. */
  label: string;
  /** One line describing what triggers it. */
  description: string;
  /**
   * The task state whose entry fires this event. Absent for non-task events
   * (e.g. the department coming online, or a manual test push).
   */
  taskState?: string;
}

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  {
    key: 'dept.online',
    label: 'Department online',
    description: 'The console/runner has started and the department is live.'
  },
  {
    key: 'task.started',
    label: 'Task started',
    description: 'A task has been picked up and work has begun.',
    taskState: 'claimed'
  },
  {
    key: 'task.needs-review',
    label: 'Task needs your review',
    description: 'A task is waiting for your approval before it can proceed.',
    taskState: 'needs-review'
  },
  {
    key: 'task.blocked',
    label: 'Task blocked',
    description: 'A task stalled or hit a ceiling and needs operator attention.',
    taskState: 'blocked'
  },
  {
    key: 'task.failed',
    label: 'Task failed',
    description: 'A task ended in failure.',
    taskState: 'failed'
  },
  {
    key: 'task.done',
    label: 'Task finished',
    description: 'A task reached done.',
    taskState: 'done'
  },
  {
    key: 'ntfy.test',
    label: 'Test notification',
    description: 'A manual test push sent from Settings to confirm delivery.'
  }
] as const;

/** The set of task states that fire a notification when a task enters them. */
export const NOTIFYING_TASK_STATES: ReadonlySet<string> = new Set(
  NOTIFICATION_EVENTS.filter(e => e.taskState).map(e => e.taskState as string)
);
