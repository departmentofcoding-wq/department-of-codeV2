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

    // Priority + tags default from the task state, but an explicit value on the
    // payload always wins. Kept here so every caller gets consistent styling.
    const priority = payload.priority ?? STATE_PRIORITY[payload.state];
    const tags = (payload.tags && payload.tags.length > 0)
      ? payload.tags
      : STATE_TAGS[payload.state];

    return this.sendMessage({ title, message: body, priority, tags });
  }

  /**
   * Sends a free-form notification (not tied to a task) to the configured topic —
   * used for the department-online ping and the manual test push. Safe no-op if
   * no topic is configured; never throws.
   */
  async sendMessage(msg: {
    title: string;
    message: string;
    priority?: number | string;
    tags?: string[];
  }): Promise<boolean> {
    if (!this.topic) {
      return false;
    }

    const transport = this.transport ?? getNtfyTransport();
    const endpoint = `${this.serverUrl}/${encodeURIComponent(this.topic)}`;
    const headers: Record<string, string> = {
      'Title': msg.title,
      'Content-Type': 'text/plain; charset=utf-8'
    };
    if (msg.priority) {
      headers['Priority'] = String(msg.priority);
    }
    if (msg.tags && msg.tags.length > 0) {
      headers['Tags'] = msg.tags.join(',');
    }

    try {
      const res = await transport.post(endpoint, msg.message, headers);
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }
}

/** Per-state ntfy priority. Absent = ntfy's own default (no header sent). */
const STATE_PRIORITY: Record<string, string> = {
  claimed: 'default',
  'needs-review': 'high',
  blocked: 'high',
  failed: 'high',
  done: 'default'
};

/** Per-state ntfy tags (emoji shortcodes). */
const STATE_TAGS: Record<string, string[]> = {
  claimed: ['rocket'],
  'needs-review': ['eyes', 'bell'],
  blocked: ['warning', 'rotating_light'],
  failed: ['x', 'rotating_light'],
  done: ['white_check_mark', 'tada']
};
