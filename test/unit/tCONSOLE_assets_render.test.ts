import { describe, expect, it } from 'vitest';
import { renderAssetsTable, escapeHtml } from '../../console/public/render.js';
import type { AssetDTO } from '../../console/contract.ts';

describe('T-CONSOLE: Department Assets Render Core', () => {
  const sampleAssets: AssetDTO[] = [
    {
      id: 'asset-101',
      name: 'Google Workspace',
      category: 'Google',
      url: 'https://workspace.google.com',
      description: 'Department email and drive storage',
      owner: 'operator',
      status: 'Active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T12:00:00.000Z'
    },
    {
      id: 'asset-102',
      name: 'Legacy Cloud VM',
      category: 'Cloud',
      url: 'https://cloud.provider.com/vm/123',
      description: null,
      owner: null,
      status: 'Inactive',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-03T15:30:00.000Z'
    }
  ];

  it('1. Table Rendering: formats asset records, category badges, links, and status classes', () => {
    const html = renderAssetsTable(sampleAssets);
    expect(html).toContain('Asset Name');
    expect(html).toContain('Google Workspace');
    expect(html).toContain('category-badge');
    expect(html).toContain('Google');
    expect(html).toContain('https://workspace.google.com');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Department email and drive storage');
    expect(html).toContain('operator');
    expect(html).toContain('state-active');
    expect(html).toContain('Active');
    expect(html).toContain('btn-edit-asset');
    expect(html).toContain('btn-delete-asset');

    // Inactive asset with nulls rendered cleanly
    expect(html).toContain('Legacy Cloud VM');
    expect(html).toContain('state-inactive');
    expect(html).toContain('Inactive');
    expect(html).toContain('—'); // Fallback for null description/owner
  });

  it('2. XSS Prevention: escapes HTML and script tags in all dynamic asset fields', () => {
    const maliciousAssets: AssetDTO[] = [
      {
        id: 'asset-xss',
        name: '<script>alert("name-xss")</script>',
        category: '<img src=x onerror=alert("cat")>',
        url: 'https://safe.com?q=<script>alert("url")</script>',
        description: '<b>bold</b> <script>alert("desc")</script>',
        owner: '<svg onload=alert("owner")>',
        status: 'Active',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ];

    const html = renderAssetsTable(maliciousAssets);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('<svg onload');

    expect(html).toContain('&lt;script&gt;alert(&quot;name-xss&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(&quot;cat&quot;)&gt;');
    expect(html).toContain('&lt;svg onload=alert(&quot;owner&quot;)&gt;');
  });

  it('2b. URL scheme guard: a javascript: asset URL is rendered inert, never as a clickable href', () => {
    const jsUrlAsset: AssetDTO[] = [
      {
        id: 'asset-js',
        name: 'Sneaky',
        category: 'Other',
        url: 'javascript:alert(document.cookie)',
        description: null,
        owner: null,
        status: 'Active',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ];
    const html = renderAssetsTable(jsUrlAsset);
    // No live link with a javascript: scheme.
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<a href="javascript');
    // The raw text is still shown (escaped), just not as an anchor.
    expect(html).toContain('javascript:alert(document.cookie)');
  });

  it('3. Empty State: renders fallback empty state card when asset list is empty or null', () => {
    const emptyHtml = renderAssetsTable([]);
    expect(emptyHtml).toContain('No department assets tracked yet.');

    const nullHtml = renderAssetsTable(null as any);
    expect(nullHtml).toContain('No department assets tracked yet.');
  });
});
