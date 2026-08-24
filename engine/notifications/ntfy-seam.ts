import type { NtfyTransport, NtfyTransportResponse } from './ntfy.ts';

let overrideTransport: NtfyTransport | null = null;

export const defaultHttpTransport: NtfyTransport = {
  async post(url: string, body: string, headers: Record<string, string>): Promise<NtfyTransportResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      const text = await res.text().catch(() => '');
      return { status: res.status, text };
    } finally {
      clearTimeout(timeoutId);
    }
  }
};

export function setNtfyTransportOverride(transport: NtfyTransport | null): void {
  overrideTransport = transport;
}

export function getNtfyTransport(): NtfyTransport {
  return overrideTransport ?? defaultHttpTransport;
}
