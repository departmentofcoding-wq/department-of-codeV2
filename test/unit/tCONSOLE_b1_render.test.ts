import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeHtml,
  renderDashboardTileGrid,
  renderTaskTable,
  renderFindingsList,
  renderJournalTimeline,
  renderRelaunchState,
  renderErrorToast
} from '../../console/public/render.js';

describe('Milestone B1 — UI Shell & Testable Render Core (T-C4)', () => {
  const dashboardFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_dashboard.json'), 'utf8'));
  const tasksFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_tasks.json'), 'utf8'));
  const findingsFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_findings.json'), 'utf8'));
  const journalFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_journal.json'), 'utf8'));
  const errorFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_error.json'), 'utf8'));

  it('1. HTML Escape Helper (B-5): escapes unsafe characters to prevent XSS', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("Tom & 'Jerry'")).toBe('Tom &amp; &#39;Jerry&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('2. renderDashboardTileGrid: formats state populations, budget spend, failure rate, and guardrails', () => {
    const html = renderDashboardTileGrid(dashboardFixture);
    expect(html).toContain('Task State Populations');
    expect(html).toContain('intake');
    expect(html).toContain('verifying');
    expect(html).toContain('12.0%'); // 0.12 * 100
    expect(html).toContain('Fix memory leak in CDP client');
    // Assert XSS string in title is HTML escaped
    expect(html).toContain('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('3. renderTaskTable: renders task rows, badges, verifier codes, and action buttons', () => {
    const html = renderTaskTable(tasksFixture);
    expect(html).toContain('task-101');
    expect(html).toContain('Fix memory leak in CDP client');
    expect(html).toContain('btn-approve'); // Approve button for task-101 (verifying & code 0)
    // Assert XSS string in task title is HTML escaped
    expect(html).toContain('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('4. renderFindingsList: renders watchdog findings with subject_kind and subject_id', () => {
    const html = renderFindingsList(findingsFixture);
    expect(html).toContain('lease_stale');
    expect(html).toContain('bureau_tasks:task-101');
    expect(html).toContain('Runner lease expired after 15000ms');
    // Assert XSS string in finding detail is HTML escaped
    expect(html).toContain('&lt;img src=x onerror=alert(&#39;xss&#39;)&gt;');
    expect(html).not.toContain('<img src=x onerror');
  });

  it('5. renderJournalTimeline: renders journal timeline entries and actors', () => {
    const html = renderJournalTimeline(journalFixture);
    expect(html).toContain('human-operator (console)');
    expect(html).toContain('Approved task task-101 via Operator Console');
    // Assert XSS string in journal detail is HTML escaped
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('6. renderRelaunchState: renders 401 fail-closed re-launch banner', () => {
    const html = renderRelaunchState('Token header x-console-token missing or invalid.');
    expect(html).toContain('Console Authentication Required');
    expect(html).toContain('Token header x-console-token missing or invalid.');
    expect(html).toContain('npm run console');
  });

  it('7. renderErrorToast: renders error envelope message and code', () => {
    const html = renderErrorToast(errorFixture);
    expect(html).toContain('Task task-103 is not in verifier-passed state');
    expect(html).toContain('[UNVERIFIED_APPROVAL_REFUSED]');
  });
});
