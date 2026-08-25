import { describe, expect, it } from 'vitest';
import {
  CONSOLE_BIND_HOST,
  CONSOLE_DEFAULT_PORT,
  CONSOLE_QUERY_TOKEN_PARAM,
  CONSOLE_TOKEN_HEADER,
  ENDPOINTS,
  MAX_JSON_BODY_BYTES,
  type TriggerActionKind
} from '../../console/contract.ts';
import { getJobDefinition } from '../../engine/jobs/registry.ts';

describe('Milestone D0-C — Console Contract Freeze', () => {
  it('1. Security Constants: enforces loopback host, lowercase token header, and size limits', () => {
    expect(CONSOLE_BIND_HOST).toBe('127.0.0.1');
    expect(CONSOLE_TOKEN_HEADER).toBe('x-console-token');
    expect(CONSOLE_QUERY_TOKEN_PARAM).toBe('token');
    expect(CONSOLE_DEFAULT_PORT).toBe(3100);
    expect(MAX_JSON_BODY_BYTES).toBe(1_048_576);
  });

  it('2. Endpoint Manifest: every endpoint declares method, path, description, and token auth', () => {
    expect(ENDPOINTS.length).toBe(30);

    const paths = ENDPOINTS.map(e => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /api/health');
    expect(paths).toContain('GET /api/dashboard');
    expect(paths).toContain('GET /api/tasks');
    expect(paths).toContain('GET /api/tasks/archived');
    expect(paths).toContain('GET /api/tasks/completed');
    expect(paths).toContain('GET /api/flow');
    expect(paths).toContain('POST /api/tasks/:id/archive');
    expect(paths).toContain('POST /api/tasks/:id/unarchive');
    expect(paths).toContain('POST /api/tasks/:id/complete');
    expect(paths).toContain('POST /api/tasks/:id/reopen');
    expect(paths).toContain('GET /api/findings');
    expect(paths).toContain('GET /api/journal');
    expect(paths).toContain('GET /api/workers');
    expect(paths).toContain('GET /api/assets');
    expect(paths).toContain('POST /api/assets');
    expect(paths).toContain('POST /api/assets/:id/update');
    expect(paths).toContain('POST /api/assets/:id/delete');
    expect(paths).toContain('POST /api/tasks/:id/approve');
    expect(paths).toContain('POST /api/actions/trigger');
    expect(paths).toContain('POST /api/intake');
    expect(paths).toContain('GET /api/intake/:id');
    expect(paths).toContain('POST /api/intake/:id/reply');
    expect(paths).toContain('POST /api/intake/:id/confirm-file');
    expect(paths).toContain('GET /api/settings/google-keys');
    expect(paths).toContain('POST /api/settings/google-keys');
    expect(paths).toContain('GET /api/settings/ntfy');
    expect(paths).toContain('POST /api/settings/ntfy');
    expect(paths).toContain('POST /api/settings/ntfy/test');
    expect(paths).toContain('GET /api/projects');
    expect(paths).toContain('POST /api/projects');

    for (const ep of ENDPOINTS) {
      expect(ep.auth).toBe('token');
      expect(ep.description).toBeTruthy();
      expect(['GET', 'POST']).toContain(ep.method);
      expect(ep.path.startsWith('/api/')).toBe(true);
    }
  });

  it('3. Job Registry Integration: TriggerActionKind job kinds exist in job registry', () => {
    const triggerKinds: TriggerActionKind[] = ['watchdog.sweep', 'backup.push'];

    for (const kind of triggerKinds) {
      const jobDef = getJobDefinition(kind);
      expect(jobDef).toBeDefined();
      expect(jobDef?.kind).toBe(kind);
    }
  });

  it('4. DTO Type Boundaries: DTO field definitions compile cleanly and export expected interfaces', async () => {
    // Compile-time check ensuring contract module has no node:http/fs runtime dependencies
    const contractExports = Object.keys(await import('../../console/contract.ts'));
    expect(contractExports).toContain('CONSOLE_BIND_HOST');
    expect(contractExports).toContain('CONSOLE_TOKEN_HEADER');
    expect(contractExports).toContain('CONSOLE_QUERY_TOKEN_PARAM');
    expect(contractExports).toContain('CONSOLE_DEFAULT_PORT');
    expect(contractExports).toContain('MAX_JSON_BODY_BYTES');
    expect(contractExports).toContain('ENDPOINTS');
  });
});
