import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderDashboardTileGrid,
  renderTaskTable,
  renderFindingsList,
  renderJournalTimeline,
  renderErrorToast
} from '../../console/public/render.js';

describe('Milestone B2 — Views Wired to Read APIs (T-C5)', () => {
  const dashboardFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_dashboard.json'), 'utf8'));
  const tasksFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_tasks.json'), 'utf8'));
  const findingsFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_findings.json'), 'utf8'));
  const journalFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_journal.json'), 'utf8'));
  const errorFixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/console_error.json'), 'utf8'));

  it('1. Non-empty DTO View Rendering: renders complete views from DTO fixtures', () => {
    const dash = renderDashboardTileGrid(dashboardFixture);
    expect(dash).toContain('Task State Populations');
    expect(dash).toContain('12.0%');

    const tasks = renderTaskTable(tasksFixture);
    expect(tasks).toContain('task-101');
    expect(tasks).toContain('task-102');
    expect(tasks).toContain('task-103');

    const findings = renderFindingsList(findingsFixture);
    expect(findings).toContain('find-101');
    expect(findings).toContain('lease_stale');

    const journal = renderJournalTimeline(journalFixture);
    expect(journal).toContain('Approved task task-101 via Operator Console');
  });

  it('2. Empty DTO View Rendering: handles empty array/null state gracefully without breaking', () => {
    const emptyDash = renderDashboardTileGrid({
      statePopulations: [],
      budgetSpend: [],
      verifyFailureRate: { total_runs: 0, failures: 0, failure_rate: 0 },
      spanKindCounts: [],
      guardrailCount: 0
    });
    expect(emptyDash).toContain('0.0%');

    const emptyTasks = renderTaskTable([]);
    expect(emptyTasks).toContain('No tasks recorded in bureau');

    const emptyFindings = renderFindingsList([]);
    expect(emptyFindings).toContain('Zero active watchdog findings. Bureau healthy.');

    const emptyJournal = renderJournalTimeline([]);
    expect(emptyJournal).toContain('No journal entries found');
  });

  it('3. Error Envelope Rendering: ApiErrorResponse renders structured error view, never blank screen', () => {
    const errorHtml = renderErrorToast(errorFixture);
    expect(errorHtml).toContain('Task task-103 is not in verifier-passed state');
    expect(errorHtml).toContain('UNVERIFIED_APPROVAL_REFUSED');

    const strErrorHtml = renderErrorToast('Network connection failed');
    expect(strErrorHtml).toContain('Network connection failed');
  });
});
