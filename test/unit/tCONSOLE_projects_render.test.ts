import { describe, expect, it } from 'vitest';
import { renderProjectsTable } from '../../console/public/render.js';
import type { ProjectDTO } from '../../console/contract.ts';

describe('T-CONSOLE: Projects Render Core', () => {
  const sample: ProjectDTO[] = [
    {
      id: 'proj-1',
      name: 'Department of Code',
      path_to_repo: 'D:\\repos\\dept-of-code',
      description: 'Primary bureau repo',
      created_at: '2026-08-25T00:00:00.000Z',
      updated_at: '2026-08-25T00:00:00.000Z'
    },
    {
      id: 'proj-2',
      name: 'Sandbox',
      path_to_repo: '/home/op/sandbox',
      description: null,
      created_at: '2026-08-24T00:00:00.000Z',
      updated_at: '2026-08-24T00:00:00.000Z'
    }
  ];

  it('1. renders project name, folder location, and description', () => {
    const html = renderProjectsTable(sample);
    expect(html).toContain('Project');
    expect(html).toContain('Folder Location');
    expect(html).toContain('Department of Code');
    expect(html).toContain('D:\\repos\\dept-of-code');
    expect(html).toContain('Primary bureau repo');
    expect(html).toContain('Sandbox');
    expect(html).toContain('/home/op/sandbox');
    // Null description falls back to an em-dash.
    expect(html).toContain('—');
  });

  it('2. escapes HTML in every dynamic field (XSS guard)', () => {
    const malicious: ProjectDTO[] = [
      {
        id: 'x',
        name: '<script>alert("name")</script>',
        path_to_repo: '/tmp/<img src=x onerror=alert(1)>',
        description: '<b>desc</b>',
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z'
      }
    ];
    const html = renderProjectsTable(malicious);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;');
  });

  it('3. empty / null renders the guidance empty state', () => {
    expect(renderProjectsTable([])).toContain('No projects registered yet');
    expect(renderProjectsTable(null as any)).toContain('No projects registered yet');
  });
});
