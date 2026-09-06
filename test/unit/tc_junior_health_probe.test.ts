import { describe, it, expect } from 'vitest';
import {
  probeJuniorCdpHealth,
  JUNIORS,
  type JuniorConfig
} from '../../engine/harness/antigravity.ts';

describe('Unit: probeJuniorCdpHealth CDP handshake', () => {
  const cfg: JuniorConfig = JUNIORS.A;

  it('valid echo round-trip (1 + 1 === 2) returns true', async () => {
    const result = await probeJuniorCdpHealth(cfg, {
      timeoutMs: 1000,
      deps: {
        getWebSocketUrl: async () => 'ws://127.0.0.1:9999/devtools/page/test',
        evaluate: async (_wsUrl, expr) => {
          if (expr === '1 + 1') return 2;
          return null;
        }
      }
    });

    expect(result).toBe(true);
  });

  it('port open but Runtime.evaluate times out or rejects returns false', async () => {
    const result = await probeJuniorCdpHealth(cfg, {
      timeoutMs: 1000,
      deps: {
        getWebSocketUrl: async () => 'ws://127.0.0.1:9999/devtools/page/test',
        evaluate: async () => {
          throw new Error('CDP timeout: Runtime.evaluate');
        }
      }
    });

    expect(result).toBe(false);
  });

  it('connection refused / no endpoint (getWebSocketUrl fails) returns false', async () => {
    const result = await probeJuniorCdpHealth(cfg, {
      timeoutMs: 1000,
      deps: {
        getWebSocketUrl: async () => null
      }
    });

    expect(result).toBe(false);
  });

  it('non-matching or malformed evaluation payload (echo !== 2) returns false', async () => {
    const result = await probeJuniorCdpHealth(cfg, {
      timeoutMs: 1000,
      deps: {
        getWebSocketUrl: async () => 'ws://127.0.0.1:9999/devtools/page/test',
        evaluate: async () => 'malformed-string'
      }
    });

    expect(result).toBe(false);
  });
});
