import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeHtml,
  safeHref,
  renderDashboardTileGrid,
  renderTaskTable,
  renderArchivedTaskTable,
  renderCompletedTaskTable,
  renderFlowPipeline,
  renderFindingsList,
  renderJournalTimeline,
  renderSettings,
  renderNtfySettingsCard,
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
    expect(html).toContain('btn-approve'); // Approve button for task-101 (needs-review & code 0)
    // Every live row offers Archive + Complete actions.
    expect(html).toContain('btn-archive');
    expect(html).toContain('btn-complete');
    // Cycles / Attempts column is surfaced (task-101: cycles 3, attempts 4).
    expect(html).toContain('Cycles / Attempts');
    // Assert XSS string in task title is HTML escaped
    expect(html).toContain('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('3b. renderTaskTable: does NOT offer approve for a still-verifying task (only needs-review)', () => {
    const html = renderTaskTable([
      { id: 'v1', title: 'Still verifying', state: 'verifying', verifier_exit_code: 0, approved_at: null, approved_by: null, plan_rounds: 0, verify_fixes: 0, cycles: 0, attempts: 0, pull_request_url: null } as any
    ]);
    expect(html).not.toContain('btn-approve');
    // but it still offers archive
    expect(html).toContain('btn-archive');
  });

  it('3c. renderArchivedTaskTable: shows reason + Unarchive, empty state when none', () => {
    expect(renderArchivedTaskTable([])).toContain('No archived tasks');
    const html = renderArchivedTaskTable([
      { id: 'arc-1', title: 'Old test task', state: 'blocked', archive_reason: 'test artifact', archived_by: 'operator', archived_at: '2026-08-24T00:00:00.000Z' } as any
    ]);
    expect(html).toContain('arc-1');
    expect(html).toContain('test artifact');
    expect(html).toContain('btn-unarchive');
    // Archived rows never offer approve.
    expect(html).not.toContain('btn-approve');
  });

  it('3c2. renderCompletedTaskTable: shows commit + note + Completed badge + Reopen, empty state when none', () => {
    expect(renderCompletedTaskTable([])).toContain('No completed tasks');
    const html = renderCompletedTaskTable([
      { id: 'ship-1', title: 'Ship the ntfy stack', state: 'claimed', completion_commit: '1c14534', completion_note: 'shipped out-of-band', completed_by: 'operator', completed_at: '2026-08-25T00:00:00.000Z' } as any
    ]);
    expect(html).toContain('ship-1');
    expect(html).toContain('1c14534');
    expect(html).toContain('shipped out-of-band');
    expect(html).toContain('Completed');
    expect(html).toContain('btn-reopen');
    // Completed rows never offer approve/archive.
    expect(html).not.toContain('btn-approve');
  });

  it('3d. renderFlowPipeline: draws a stepper per in-flight task and flags stuck ones', () => {
    expect(renderFlowPipeline({ stages: [], tasks: [] })).toContain('The line is idle');
    const html = renderFlowPipeline({
      stages: ['Intake', 'Queued', 'In progress', 'Verify', 'Review', 'Done'],
      tasks: [
        { task_id: 'f1', title: 'Moving task', state: 'claimed', stage_index: 2, stage_label: 'In progress', responsible_role: 'junior-engineer', last_actor_role: 'junior-engineer', last_activity_ts: '2026-08-24T00:00:00.000Z', last_activity_kind: 'observation', is_stuck: false, stuck_reason: null, plan_rounds: 1, verify_fixes: 0, cycles: 1, attempts: 1 },
        { task_id: 'f2', title: 'Stuck task', state: 'blocked', stage_index: 2, stage_label: 'In progress', responsible_role: 'junior-engineer', last_actor_role: 'senior-engineer', last_activity_ts: '2026-08-24T00:00:00.000Z', last_activity_kind: 'review', is_stuck: true, stuck_reason: 'Blocked — needs operator to re-arm', plan_rounds: 3, verify_fixes: 0, cycles: 5, attempts: 2 }
      ]
    } as any);
    expect(html).toContain('Moving task');
    expect(html).toContain('Stuck task');
    expect(html).toContain('2 tasks in flight');
    expect(html).toContain('1 stuck');
    expect(html).toContain('Blocked — needs operator to re-arm');
    expect(html).toContain('junior-engineer');
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

  it('8. renderSettings: renders operator console settings and configuration', () => {
    const html = renderSettings({
      theme: 'dark',
      isPaused: false,
      hasToken: true,
      tokenPreview: 'abc12345...'
    });
    expect(html).toContain('Operator Session');
    expect(html).toContain('abc12345...');
    expect(html).toContain('AUTO_REFRESH_INTERVAL');
    expect(html).toContain('5000ms');
    expect(html).toContain('Ntfy Push Notifications');
  });

  it('8b. renderNtfySettingsCard: renders configured topic and inputs', () => {
    const card = renderNtfySettingsCard({
      ntfy_server_url: 'https://custom-ntfy.io',
      ntfy_topic: 'my-alerts',
      enabled: true
    });
    expect(card).toContain('Ntfy Push Notifications');
    expect(card).toContain('my-alerts');
    expect(card).toContain('https://custom-ntfy.io');
    expect(card).toContain('save-ntfy-settings-btn');
  });

  it('9. safeHref: only http(s) URLs become hrefs; javascript:/data: schemes are refused', () => {
    expect(safeHref('https://aistudio.google.com')).toBe('https://aistudio.google.com');
    expect(safeHref('http://localhost:3000')).toBe('http://localhost:3000');
    // Dangerous schemes escapeHtml cannot neutralize (no escapable chars) → ''.
    expect(safeHref('javascript:alert(1)')).toBe('');
    expect(safeHref('JavaScript:alert(1)')).toBe('');
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeHref('vbscript:msgbox(1)')).toBe('');
    expect(safeHref(null)).toBe('');
    expect(safeHref('')).toBe('');
  });

  it('10. renderJournalTimeline: a javascript: string in a detail never becomes a live link', () => {
    const html = renderJournalTimeline([
      {
        id: 1,
        ts: '2026-08-24T00:00:00.000Z',
        kind: 'human',
        actor_role: 'human-operator',
        provider: 'console',
        model: 'operator',
        account: null,
        task_id: 'task-xyz',
        work_uuid: 'w1',
        work_title: 'Do the thing',
        job_id: null,
        detail: 'javascript:alert(1)'
      } as any
    ]);
    expect(html).not.toContain('href="javascript:');
  });

  it('11. renderJournalTimeline: GROUPS entries by task, with a header per task and a system group last', () => {
    const entries = [
      { id: 1, ts: 't1', kind: 'transition', actor_role: 'foreman', provider: 'deterministic', model: 'core', account: null, task_id: 'task-A', work_uuid: 'wA', work_title: 'Assets tab', job_id: null, detail: 'queued->claimed' },
      { id: 2, ts: 't2', kind: 'system', actor_role: 'system', provider: 'deterministic', model: 'core', account: null, task_id: null, work_uuid: null, work_title: null, job_id: null, detail: 'watchdog swept' },
      { id: 3, ts: 't3', kind: 'observation', actor_role: 'junior-engineer', provider: 'antigravity', model: 'gemini', account: null, task_id: 'task-B', work_uuid: 'wB', work_title: 'Backup fix', job_id: null, detail: 'authored plan' },
      { id: 4, ts: 't4', kind: 'review', actor_role: 'senior-engineer', provider: 'claude', model: 'opus', account: null, task_id: 'task-A', work_uuid: 'wA', work_title: 'Assets tab', job_id: null, detail: 'approved' }
    ];
    const html = renderJournalTimeline(entries as any);
    // Each task gets a header naming it, with its title.
    expect(html).toContain('timeline-group');
    expect(html).toContain('Assets tab');
    expect(html).toContain('task-A');
    expect(html).toContain('Backup fix');
    expect(html).toContain('task-B');
    // The unattributed/system group is present and rendered last.
    expect(html).toContain('Unattributed / system actions');
    const idxTaskA = html.indexOf('task-A');
    const idxSystem = html.indexOf('Unattributed / system actions');
    expect(idxTaskA).toBeLessThan(idxSystem);
    // Task A's two entries (queued->claimed and approved) are grouped together
    // under a single header whose count is 2 (details are HTML-escaped).
    expect(html).toContain('queued-&gt;claimed');
    expect(html).toContain('approved');
    expect(html).toContain('timeline-group-count">2<');
  });
});
