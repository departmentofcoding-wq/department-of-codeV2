import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { setNtfyTransportOverride } from '../../engine/notifications/ntfy-seam.ts';
import { NtfyClient, type NtfyTransport } from '../../engine/notifications/ntfy.ts';
import { NOTIFYING_TASK_STATES, NOTIFICATION_EVENTS } from '../../engine/notifications/events.ts';
import {
  notifyTaskStateChange,
  notifyDepartmentOnline,
  sendTestNotification
} from '../../engine/state/notifications.ts';
import type { DbConnection } from '../../engine/contract/types.ts';

describe('Ntfy notification events (started / needs-review / online / test)', () => {
  let db: DbConnection & { close: () => void };
  let calls: Array<{ url: string; body: string; headers: Record<string, string> }>;

  const capture: NtfyTransport = {
    async post(url, body, headers) {
      calls.push({ url, body, headers });
      return { status: 200, text: 'ok' };
    }
  };

  function setTopic(topic: string) {
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', 'https://ntfy.sh')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      topic
    );
  }

  function seedTask(id: string, state: string) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES (?, 'A Task', ?, ?, ?, ?)`,
      id, state, `work-${id}`, now, now
    );
  }

  beforeEach(() => {
    db = createFakeDb();
    calls = [];
    setNtfyTransportOverride(capture);
  });

  afterEach(() => {
    setNtfyTransportOverride(null);
    db.close();
  });

  it('1. NOTIFYING_TASK_STATES covers filed, started, needs-review, blocked, failed, done', () => {
    expect(NOTIFYING_TASK_STATES.has('queued')).toBe(true);
    expect(NOTIFYING_TASK_STATES.has('claimed')).toBe(true);
    expect(NOTIFYING_TASK_STATES.has('needs-review')).toBe(true);
    expect(NOTIFYING_TASK_STATES.has('blocked')).toBe(true);
    expect(NOTIFYING_TASK_STATES.has('failed')).toBe(true);
    expect(NOTIFYING_TASK_STATES.has('done')).toBe(true);
    // Non-notifying states stay quiet.
    expect(NOTIFYING_TASK_STATES.has('verifying')).toBe(false);
    expect(NOTIFYING_TASK_STATES.has('intake')).toBe(false);
  });

  it('2. needs-review fires a high-priority push (the phone-approval trigger)', async () => {
    setTopic('dept-alerts');
    seedTask('t-nr', 'needs-review');

    await notifyTaskStateChange(db, { taskId: 't-nr', title: 'Approve me', state: 'needs-review' });

    expect(calls.length).toBe(1);
    expect(calls[0].headers['Title']).toContain('NEEDS-REVIEW');
    expect(calls[0].headers['Priority']).toBe('high');
    expect(calls[0].headers['Tags']).toContain('eyes');

    // Journaled as a system span recording success without the topic value.
    const span = db.get<{ detail: string }>(
      "SELECT * FROM bureau_journal WHERE detail LIKE '%ntfy_notification%' AND detail LIKE '%needs-review%'"
    );
    expect(span).toBeDefined();
    expect(span?.detail).not.toContain('dept-alerts');
  });

  it('3. task started (claimed) fires a push', async () => {
    setTopic('dept-alerts');
    seedTask('t-c', 'claimed');
    await notifyTaskStateChange(db, { taskId: 't-c', title: 'Started', state: 'claimed' });
    expect(calls.length).toBe(1);
    expect(calls[0].headers['Title']).toContain('CLAIMED');
  });

  it('4. notifyDepartmentOnline sends when a topic is set, and is a no-op otherwise', async () => {
    // No topic yet -> no send.
    const before = await notifyDepartmentOnline(db);
    expect(before).toBe(false);
    expect(calls.length).toBe(0);

    setTopic('dept-alerts');
    const after = await notifyDepartmentOnline(db);
    expect(after).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].headers['Title']).toContain('Online');

    const span = db.get<{ detail: string }>(
      "SELECT * FROM bureau_journal WHERE detail LIKE '%ntfy_department_online%'"
    );
    expect(span).toBeDefined();
  });

  it('5. sendTestNotification reports configured + sent, and journals a human span', async () => {
    const unconfigured = await sendTestNotification(db);
    expect(unconfigured).toEqual({ configured: false, sent: false });
    expect(calls.length).toBe(0);

    setTopic('dept-alerts');
    const res = await sendTestNotification(db);
    expect(res.configured).toBe(true);
    expect(res.sent).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].headers['Title']).toContain('Test notification');

    const span = db.get<{ kind: string; detail: string }>(
      "SELECT * FROM bureau_journal WHERE detail LIKE '%ntfy_test%'"
    );
    expect(span).toBeDefined();
    expect(span?.kind).toBe('human');
  });

  it('6. NtfyClient.sendMessage sends a free-form push and no-ops without a topic', async () => {
    const noTopic = new NtfyClient({ topic: '' });
    expect(await noTopic.sendMessage({ title: 'x', message: 'y' })).toBe(false);
    expect(calls.length).toBe(0);

    const client = new NtfyClient({ serverUrl: 'https://ntfy.sh', topic: 'free' });
    const ok = await client.sendMessage({ title: 'Hi', message: 'Body', priority: 'high', tags: ['bell'] });
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://ntfy.sh/free');
    expect(calls[0].headers['Title']).toBe('Hi');
    expect(calls[0].headers['Priority']).toBe('high');
    expect(calls[0].headers['Tags']).toBe('bell');
    expect(calls[0].body).toBe('Body');
  });

  it('7. the events catalog exposes both task and non-task events for the Settings list', () => {
    const keys = NOTIFICATION_EVENTS.map(e => e.key);
    expect(keys).toContain('dept.online');
    expect(keys).toContain('task.filed');
    expect(keys).toContain('task.started');
    expect(keys).toContain('task.needs-review');
    expect(keys).toContain('ntfy.test');
    for (const e of NOTIFICATION_EVENTS) {
      expect(e.label).toBeTruthy();
      expect(e.description).toBeTruthy();
    }
  });
});
