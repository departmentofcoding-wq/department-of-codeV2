import { describe, expect, it } from 'vitest';
import {
  renderProjectsTable,
  renderProvisioningChip,
  renderGithubSettingsCard
} from '../../console/public/render.js';
import type { ProjectDTO, GithubSettingsDTO } from '../../console/contract.ts';

describe('T-CONSOLE: Projects Render Core', () => {
  const sample: ProjectDTO[] = [
    {
      id: 'proj-1',
      name: 'Department of Code',
      path_to_repo: 'D:\\repos\\dept-of-code',
      description: 'Primary bureau repo',
      github_url: 'https://github.com/my-org/dept-of-code',
      created_at: '2026-08-25T00:00:00.000Z',
      updated_at: '2026-08-25T00:00:00.000Z'
    },
    {
      id: 'proj-2',
      name: 'Sandbox',
      path_to_repo: '/home/op/sandbox',
      description: null,
      github_url: null,
      created_at: '2026-08-24T00:00:00.000Z',
      updated_at: '2026-08-24T00:00:00.000Z'
    }
  ];

  it('1. renders project name, folder location, GitHub remote, and description', () => {
    const html = renderProjectsTable(sample);
    expect(html).toContain('Project');
    expect(html).toContain('Folder Location');
    expect(html).toContain('GitHub Remote');
    expect(html).toContain('Department of Code');
    expect(html).toContain('D:\\repos\\dept-of-code');
    expect(html).toContain('Primary bureau repo');
    expect(html).toContain('https://github.com/my-org/dept-of-code');
    expect(html).toContain('Sandbox');
    expect(html).toContain('/home/op/sandbox');
    // Null description / remote falls back to an em-dash.
    expect(html).toContain('—');
  });

  it('2. escapes HTML in every dynamic field (XSS guard)', () => {
    const malicious: ProjectDTO[] = [
      {
        id: 'x',
        name: '<script>alert("name")</script>',
        path_to_repo: '/tmp/<img src=x onerror=alert(1)>',
        description: '<b>desc</b>',
        github_url: 'javascript:alert(1)',
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z'
      }
    ];
    const html = renderProjectsTable(malicious);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;');
  });

  it('3. empty / null renders the guidance empty state', () => {
    expect(renderProjectsTable([])).toContain('No projects registered yet');
    expect(renderProjectsTable(null as any)).toContain('No projects registered yet');
  });

  it('4. renderProvisioningChip: renders pending, done, and failed states', () => {
    const pendingHtml = renderProvisioningChip('job-1', 'my-app', 'running');
    expect(pendingHtml).toContain('chip-provisioning');
    expect(pendingHtml).toContain('⏳ Provisioning my-app...');

    const doneHtml = renderProvisioningChip('job-1', 'my-app', 'done');
    expect(doneHtml).toContain('chip-done');
    expect(doneHtml).toContain('✅ Provisioned');

    const failedHtml = renderProvisioningChip('job-1', 'my-app', 'failed');
    expect(failedHtml).toContain('chip-failed');
    expect(failedHtml).toContain('❌ Failed');
  });

  it('5. renderGithubSettingsCard: renders connected account, scopes, and projects root safely', () => {
    const connectedStatus: GithubSettingsDTO = {
      authenticated: true,
      login: 'bureau-admin',
      scopes: ['repo', 'read:org'],
      projects_root: 'D:\\Dept of code v2\\projects',
      repo_prefix: 'bureau-'
    };

    const connectedHtml = renderGithubSettingsCard(connectedStatus);
    expect(connectedHtml).toContain('Connected');
    expect(connectedHtml).toContain('@bureau-admin');
    expect(connectedHtml).toContain('repo');
    expect(connectedHtml).toContain('read:org');
    expect(connectedHtml).toContain('D:\\Dept of code v2\\projects');
    expect(connectedHtml).toContain('bureau-');

    const disconnectedStatus: GithubSettingsDTO = {
      authenticated: false,
      login: null,
      scopes: [],
      projects_root: 'D:\\Dept of code v2\\projects',
      repo_prefix: 'bureau-'
    };

    const disconnectedHtml = renderGithubSettingsCard(disconnectedStatus);
    expect(disconnectedHtml).toContain('Disconnected');
    expect(disconnectedHtml).toContain('Not authenticated with GitHub CLI (gh)');
  });
});

