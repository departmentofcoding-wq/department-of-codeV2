import { getNtfyTransport } from './ntfy-seam.ts';

export interface NtfyConfig {
  serverUrl?: string;
  topic?: string;
}

export interface NtfyNotificationPayload {
  taskId: string;
  title: string;
  state: string;
  reason?: string;
  priority?: number;
  tags?: string[];
}

export interface NtfyTransportResponse {
  status: number;
  text: string;
}

export interface NtfyTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<NtfyTransportResponse>;
}

export class NtfyClient {
  serverUrl: string;
  topic: string;
  transport?: NtfyTransport;

  constructor(config?: NtfyConfig, transport?: NtfyTransport) {
    this.serverUrl = (config?.serverUrl?.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
    this.topic = config?.topic?.trim() || '';
    this.transport = transport;
  }

  /**
   * Dispatches an HTTP POST notification to the configured ntfy topic.
   * Notifications include: Task ID, Title, and status/reason.
   * Safe no-op if no topic is configured; never throws or crashes caller.
   */
  async sendNotification(payload: NtfyNotificationPayload): Promise<boolean> {
    if (!this.topic) {
      return false;
    }

    const transport = this.transport ?? getNtfyTransport();
    const endpoint = `${this.serverUrl}/${encodeURIComponent(this.topic)}`;
    const title = `[Department of Code] Task ${payload.taskId} -> ${payload.state.toUpperCase()}`;
    const lines = [
      `Task ID: ${payload.taskId}`,
      `Title: ${payload.title}`,
      `Status: ${payload.state}`
    ];
    if (payload.reason) {
      lines.push(`Reason: ${payload.reason}`);
    }
    const body = lines.join('\n');

    const headers: Record<string, string> = {
      'Title': title,
      'Content-Type': 'text/plain; charset=utf-8'
    };

    if (payload.priority) {
      headers['Priority'] = String(payload.priority);
    } else if (payload.state === 'blocked') {
      headers['Priority'] = 'high';
    } else if (payload.state === 'done') {
      headers['Priority'] = 'default';
    }

    if (payload.tags && payload.tags.length > 0) {
      headers['Tags'] = payload.tags.join(',');
    } else if (payload.state === 'blocked') {
      headers['Tags'] = 'warning,rotating_light';
    } else if (payload.state === 'done') {
      headers['Tags'] = 'white_check_mark,tada';
    }

    try {
      const res = await transport.post(endpoint, body, headers);
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }
}
