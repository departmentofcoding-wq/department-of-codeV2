import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NtfyClient, type NtfyTransport, type NtfyNotificationPayload } from '../../engine/notifications/ntfy.ts';
import { setNtfyTransportOverride } from '../../engine/notifications/ntfy-seam.ts';

describe('NtfyClient Unit Tests', () => {
  let capturedCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

  const mockTransport: NtfyTransport = {
    async post(url: string, body: string, headers: Record<string, string>) {
      capturedCalls.push({ url, body, headers });
      return { status: 200, text: '{"id":"test-msg"}' };
    }
  };

  beforeEach(() => {
    capturedCalls = [];
    setNtfyTransportOverride(mockTransport);
  });

  afterEach(() => {
    setNtfyTransportOverride(null);
  });

  it('formats endpoint URL and message body correctly for blocked tasks', async () => {
    const client = new NtfyClient({
      serverUrl: 'https://ntfy.sh/',
      topic: 'dept-alerts'
    });

    const payload: NtfyNotificationPayload = {
      taskId: 'task-1234',
      title: 'Fix engine memory leak',
      state: 'blocked',
      reason: 'verify_fixes ceiling reached'
    };

    const ok = await client.sendNotification(payload);

    expect(ok).toBe(true);
    expect(capturedCalls.length).toBe(1);
    const call = capturedCalls[0];
    expect(call.url).toBe('https://ntfy.sh/dept-alerts');
    expect(call.headers['Title']).toContain('Task task-1234 -> BLOCKED');
    expect(call.headers['Priority']).toBe('high');
    expect(call.headers['Tags']).toBe('warning,rotating_light');
    expect(call.body).toContain('Task ID: task-1234');
    expect(call.body).toContain('Title: Fix engine memory leak');
    expect(call.body).toContain('Status: blocked');
    expect(call.body).toContain('Reason: verify_fixes ceiling reached');
  });

  it('formats endpoint URL and message body correctly for done tasks', async () => {
    const client = new NtfyClient({
      serverUrl: 'https://custom-ntfy.internal',
      topic: 'dept-shipped'
    });

    const payload: NtfyNotificationPayload = {
      taskId: 'task-5678',
      title: 'Add asset tab',
      state: 'done'
    };

    const ok = await client.sendNotification(payload);

    expect(ok).toBe(true);
    expect(capturedCalls.length).toBe(1);
    const call = capturedCalls[0];
    expect(call.url).toBe('https://custom-ntfy.internal/dept-shipped');
    expect(call.headers['Title']).toContain('Task task-5678 -> DONE');
    expect(call.headers['Priority']).toBe('default');
    expect(call.headers['Tags']).toBe('white_check_mark,tada');
    expect(call.body).toContain('Task ID: task-5678');
    expect(call.body).toContain('Title: Add asset tab');
    expect(call.body).toContain('Status: done');
    expect(call.body).not.toContain('Reason:');
  });

  it('is a safe no-op when topic is empty or missing', async () => {
    const client = new NtfyClient({
      serverUrl: 'https://ntfy.sh',
      topic: ''
    });

    const ok = await client.sendNotification({
      taskId: 'task-999',
      title: 'Do nothing',
      state: 'blocked'
    });

    expect(ok).toBe(false);
    expect(capturedCalls.length).toBe(0);
  });

  it('handles transport non-2xx status and errors gracefully without throwing', async () => {
    setNtfyTransportOverride({
      async post() {
        return { status: 500, text: 'Internal Server Error' };
      }
    });

    const client = new NtfyClient({ topic: 'test-topic' });
    const ok = await client.sendNotification({
      taskId: 'task-err',
      title: 'Error test',
      state: 'blocked'
    });

    expect(ok).toBe(false);

    // Also test throwing transport
    setNtfyTransportOverride({
      async post() {
        throw new Error('Connection refused');
      }
    });

    const okThrow = await client.sendNotification({
      taskId: 'task-throw',
      title: 'Throw test',
      state: 'blocked'
    });

    expect(okThrow).toBe(false);
  });
});
