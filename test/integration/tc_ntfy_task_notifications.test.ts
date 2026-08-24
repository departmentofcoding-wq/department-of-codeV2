import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { transition } from '../../engine/state/machine.ts';
import { setNtfyTransportOverride } from '../../engine/notifications/ntfy-seam.ts';
import { subscribeTaskStateChange, clearTaskStateSubscribers, type TaskStateChangeEvent } from '../../engine/state/notifications.ts';
import type { DbConnection, AttributionTuple } from '../../engine/contract/types.ts';

const SYSTEM_ATTR: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

const OPERATOR_ATTR: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'operator',
  account: 'operator'
};

const VERIFIER_ATTR: AttributionTuple = {
  actor_role: 'verifier',
  provider: 'deterministic',
  model: 'core',
  account: null
};

describe('T-NTFY: Task status change notifications integration', () => {
  let db: DbConnection & { close: () => void };
  let capturedPosts: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    db = createFakeDb();
    capturedPosts = [];
    clearTaskStateSubscribers();
    setNtfyTransportOverride({
      async post(url, body, headers) {
        capturedPosts.push({ url, body, headers });
        return { status: 200, text: 'ok' };
      }
    });

    // Seed task in intake state
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO bureau_tasks (
        id, title, intent, spec, acceptance, verify_cmd, state, work_uuid, created_at, updated_at
      ) VALUES (
        'task-ntfy-test', 'Integrate push notifications', 'Intent text', 'Spec text', 'Acceptance text',
        'npm test', 'intake', 'work-uuid-1', ?, ?
      )
    `, now, now);
  });

  afterEach(() => {
    setNtfyTransportOverride(null);
    clearTaskStateSubscribers();
    db.close();
  });

  it('triggers formatted ntfy notification when task transitions to blocked', async () => {
    // Configure ntfy settings in bureau_meta
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://ntfy.sh')");
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', 'bureau-alerts-topic')");

    // Move task: intake -> queued -> claimed -> verifying -> blocked
    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);

    expect(capturedPosts.length).toBe(0);

    transition(db, 'task-ntfy-test', 'blocked', VERIFIER_ATTR, {
      reason: 'verify_fixes ceiling (2) reached'
    });

    // Wait a tick for async notification dispatch
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedPosts.length).toBe(1);
    const post = capturedPosts[0];
    expect(post.url).toBe('https://ntfy.sh/bureau-alerts-topic');
    expect(post.headers['Title']).toContain('Task task-ntfy-test -> BLOCKED');
    expect(post.headers['Priority']).toBe('high');
    expect(post.headers['Tags']).toBe('warning,rotating_light');
    expect(post.body).toContain('Task ID: task-ntfy-test');
    expect(post.body).toContain('Title: Integrate push notifications');
    expect(post.body).toContain('Status: blocked');
    expect(post.body).toContain('Reason: verify_fixes ceiling (2) reached');
  });

  it('triggers formatted ntfy notification when task transitions to done', async () => {
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://alerts.internal')");
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', 'deployments')");

    // Advance task to needs-review with exit code 0 and approval
    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);
    db.run("UPDATE bureau_tasks SET verifier_exit_code = 0 WHERE id = 'task-ntfy-test'");
    transition(db, 'task-ntfy-test', 'needs-review', SYSTEM_ATTR);
    const now = new Date().toISOString();
    db.run("UPDATE bureau_tasks SET approved_at = ?, approved_by = ? WHERE id = 'task-ntfy-test'", now, 'operator');

    expect(capturedPosts.length).toBe(0);

    // Transition needs-review -> done
    transition(db, 'task-ntfy-test', 'done', SYSTEM_ATTR, { action: 'merge', prNumber: 42 });

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedPosts.length).toBe(1);
    const post = capturedPosts[0];
    expect(post.url).toBe('https://alerts.internal/deployments');
    expect(post.headers['Title']).toContain('Task task-ntfy-test -> DONE');
    expect(post.headers['Priority']).toBe('default');
    expect(post.headers['Tags']).toBe('white_check_mark,tada');
    expect(post.body).toContain('Task ID: task-ntfy-test');
    expect(post.body).toContain('Title: Integrate push notifications');
    expect(post.body).toContain('Status: done');
    expect(post.body).toContain('Reason: merge');
  });

  it('safely skips ntfy post when no topic is configured in bureau_meta', async () => {
    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'blocked', VERIFIER_ATTR, { reason: 'manual block' });

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedPosts.length).toBe(0);
  });

  it('notifies registered in-memory subscribers on blocked/done transitions', async () => {
    const events: TaskStateChangeEvent[] = [];
    const unsubscribe = subscribeTaskStateChange((e) => {
      events.push(e);
    });

    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'blocked', VERIFIER_ATTR, { reason: 'timeout' });

    await new Promise((r) => setTimeout(r, 10));

    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      taskId: 'task-ntfy-test',
      title: 'Integrate push notifications',
      state: 'blocked',
      reason: 'timeout'
    });

    unsubscribe();
  });
});
