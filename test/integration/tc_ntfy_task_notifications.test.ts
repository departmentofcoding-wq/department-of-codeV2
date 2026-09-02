import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { transition } from '../../engine/state/machine.ts';
import { fileTask, drainFilingNotifications } from '../../engine/filing/file_task.ts';
import { appendIntakeMessage, confirmVerify, createSession, updateSessionDraft } from '../../engine/intake/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { setOfficerClientOverride } from '../../engine/officers/task_intake_officer.ts';
import { drainSingleJob } from '../../runner/main.ts';
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
    setOfficerClientOverride(null);
    clearTaskStateSubscribers();
    db.close();
  });

  it('triggers formatted ntfy notification when task transitions to blocked', async () => {
    // Configure ntfy settings in bureau_meta
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://ntfy.sh')");
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', 'bureau-alerts-topic')");

    // Move task: intake -> queued -> claimed -> verifying -> blocked. `queued`
    // (filed) and `claimed` (started) fire pushes too, so isolate the blocked
    // one by state.
    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'blocked', VERIFIER_ATTR, {
      reason: 'verify_fixes ceiling (2) reached'
    });

    // Wait a tick for async notification dispatch.
    await new Promise((r) => setTimeout(r, 20));

    // 'queued' (filed), 'claimed' (started) and 'blocked' all notify;
    // 'verifying' does not.
    const started = capturedPosts.find((p) => p.headers['Title'].includes('-> CLAIMED'));
    const post = capturedPosts.find((p) => p.headers['Title'].includes('-> BLOCKED'));
    expect(started).toBeDefined();
    expect(post).toBeDefined();
    expect(post!.url).toBe('https://ntfy.sh/bureau-alerts-topic');
    expect(post!.headers['Title']).toContain('Task task-ntfy-test -> BLOCKED');
    expect(post!.headers['Priority']).toBe('high');
    expect(post!.headers['Tags']).toBe('warning,rotating_light');
    expect(post!.body).toContain('Task ID: task-ntfy-test');
    expect(post!.body).toContain('Title: Integrate push notifications');
    expect(post!.body).toContain('Status: blocked');
    expect(post!.body).toContain('Reason: verify_fixes ceiling (2) reached');
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

    // Transition needs-review -> done
    transition(db, 'task-ntfy-test', 'done', SYSTEM_ATTR, { action: 'merge', prNumber: 42 });

    await new Promise((r) => setTimeout(r, 20));

    // 'claimed', 'needs-review', and 'done' all notify. Isolate the done push.
    const review = capturedPosts.find((p) => p.headers['Title'].includes('-> NEEDS-REVIEW'));
    const post = capturedPosts.find((p) => p.headers['Title'].includes('-> DONE'));
    expect(review).toBeDefined();
    // needs-review is the phone-approval trigger: high priority, an "eyes" tag.
    expect(review!.headers['Priority']).toBe('high');
    expect(review!.headers['Tags']).toContain('eyes');
    expect(post).toBeDefined();
    expect(post!.url).toBe('https://alerts.internal/deployments');
    expect(post!.headers['Title']).toContain('Task task-ntfy-test -> DONE');
    expect(post!.headers['Priority']).toBe('default');
    expect(post!.headers['Tags']).toBe('white_check_mark,tada');
    expect(post!.body).toContain('Status: done');
    expect(post!.body).toContain('Reason: merge');
  });

  it('safely skips ntfy post when no topic is configured in bureau_meta', async () => {
    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'blocked', VERIFIER_ATTR, { reason: 'manual block' });

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedPosts.length).toBe(0);
  });

  it('notifies registered in-memory subscribers on notifying transitions (started + blocked)', async () => {
    const events: TaskStateChangeEvent[] = [];
    const unsubscribe = subscribeTaskStateChange((e) => {
      events.push(e);
    });

    transition(db, 'task-ntfy-test', 'queued', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'claimed', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'verifying', SYSTEM_ATTR);
    transition(db, 'task-ntfy-test', 'blocked', VERIFIER_ATTR, { reason: 'timeout' });

    await new Promise((r) => setTimeout(r, 20));

    // 'queued' (filed), 'claimed' (started) and 'blocked' notify;
    // 'verifying' stays quiet.
    const states = events.map((e) => e.state);
    expect(states).toContain('queued');
    expect(states).toContain('claimed');
    expect(states).toContain('blocked');
    expect(states).not.toContain('verifying');
    expect(events.find((e) => e.state === 'blocked')).toEqual({
      taskId: 'task-ntfy-test',
      title: 'Integrate push notifications',
      state: 'blocked',
      reason: 'timeout'
    });

    unsubscribe();
  });

  it('pushes a QUEUED notification when a task is filed, and does not duplicate on idempotent re-file', async () => {
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://ntfy.sh')");
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', 'bureau-alerts-topic')");

    // A complete, confirmed intake session — the same door the console, the
    // CLI, and the agent autofile all walk through.
    const session = createSession(db, { attribution: OPERATOR_ATTR });
    updateSessionDraft(db, session.id, {
      title: 'Notify on filing',
      intent: 'The operator wants a push when a task is filed',
      verify_cmd: 'npm test'
    });
    confirmVerify(db, session.id, OPERATOR_ATTR);

    const task = fileTask(db, session.id, OPERATOR_ATTR);
    expect(task.state).toBe('queued');

    await new Promise((r) => setTimeout(r, 20));

    expect(capturedPosts.length).toBe(1);
    expect(capturedPosts[0].url).toBe('https://ntfy.sh/bureau-alerts-topic');
    expect(capturedPosts[0].headers['Title']).toContain('-> QUEUED');
    expect(capturedPosts[0].headers['Priority']).toBe('default');
    expect(capturedPosts[0].headers['Tags']).toBe('inbox_tray,memo');
    expect(capturedPosts[0].body).toContain('Title: Notify on filing');
    expect(capturedPosts[0].body).toContain('Status: queued');
    expect(capturedPosts[0].body).toContain('Reason: Task filed');

    // Idempotent re-file returns the same task and must NOT push again.
    const again = fileTask(db, session.id, OPERATOR_ATTR);
    expect(again.id).toBe(task.id);

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedPosts.length).toBe(1);
  });

  it('drainFilingNotifications awaits the filing push so its journal span survives CLI shutdown', async () => {
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://ntfy.sh')");
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', 'bureau-alerts-topic')");

    // A transport that only resolves when the test releases it — models a push
    // still in flight when a short-lived CLI would reach its db.close().
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setNtfyTransportOverride({
      async post() {
        await gate;
        return { status: 200, text: 'ok' };
      }
    });

    const session = createSession(db, { attribution: OPERATOR_ATTR });
    updateSessionDraft(db, session.id, {
      title: 'Drain before close',
      intent: 'The journal span must survive CLI shutdown',
      verify_cmd: 'npm test'
    });
    confirmVerify(db, session.id, OPERATOR_ATTR);

    const task = fileTask(db, session.id, OPERATOR_ATTR);

    const spanQuery = "SELECT detail FROM bureau_journal WHERE task_id = ? AND detail LIKE '%ntfy_notification%'";
    // Push still in flight: the span is NOT yet written.
    expect(db.get(spanQuery, task.id)).toBeUndefined();

    release();
    await drainFilingNotifications();

    // After the drain the push has settled and its span is durable — a CLI
    // may now close the DB and exit without losing the record.
    const span = db.get<{ detail: string }>(spanQuery, task.id);
    expect(span).toBeDefined();
    expect(span!.detail).toContain('"state":"queued"');
    expect(span!.detail).not.toContain('bureau-alerts-topic');
  });

  it('officer-driven file_task inside a drained intake.turn job is covered by the drain (scripts/intake.ts close path)', async () => {
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://ntfy.sh')");
    db.run("INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', 'bureau-alerts-topic')");

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setNtfyTransportOverride({
      async post() {
        await gate;
        return { status: 200, text: 'ok' };
      }
    });

    // The conversational intake CLI's default path: the officer files via its
    // file_task tool while drainSingleJob runs the intake.turn job in-process.
    const session = createSession(db, {
      title: 'Officer files with drain',
      attribution: OPERATOR_ATTR
    });
    const mockClient = new MockClient([
      {
        text: 'Proposing fields.',
        toolCalls: [
          { id: 'c1', name: 'propose_field', arguments: { field: 'intent', value: 'Prove the officer-filed push is drained before close' } },
          { id: 'c2', name: 'propose_verify', arguments: { command: 'npm test' } },
          { id: 'c2b', name: 'ask_human', arguments: { question: 'Please confirm the verification command: npm test' } }
        ],
        tokensIn: 10, tokensOut: 5, latencyMs: 1, costUsd: null,
        finishReason: 'tool_calls', truncated: false
      },
      {
        text: 'Filing.',
        toolCalls: [{ id: 'c3', name: 'file_task', arguments: {} }],
        tokensIn: 10, tokensOut: 5, latencyMs: 1, costUsd: null,
        finishReason: 'tool_calls', truncated: false
      }
    ]);
    setOfficerClientOverride(mockClient);

    const job1 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job1.id);

    appendIntakeMessage(db, session.id, {
      role: 'human',
      content: 'Confirmed — please file the task.',
      attribution: OPERATOR_ATTR
    });
    confirmVerify(db, session.id, OPERATOR_ATTR);

    const job2 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job2.id);

    const task = db.get<{ id: string; state: string }>(
      'SELECT id, state FROM bureau_tasks WHERE intake_session_id = ?',
      session.id
    );
    expect(task).toBeDefined();
    expect(task!.state).toBe('queued');

    const spanQuery = "SELECT detail FROM bureau_journal WHERE task_id = ? AND detail LIKE '%ntfy_notification%'";
    // The job drained but the push is still in flight — parked in the
    // filing-notification set, NOT yet journaled.
    expect(db.get(spanQuery, task!.id)).toBeUndefined();

    release();
    await drainFilingNotifications();

    // The post-drain wait the CLI now performs recovers the span.
    expect(db.get(spanQuery, task!.id)).toBeDefined();
  });
});
