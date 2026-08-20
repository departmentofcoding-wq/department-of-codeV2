/**
 * Operator Console Pure Render Core (Vanilla JS ES Module)
 * Converts D0-C DTO objects to HTML markup strings.
 *
 * Security: HTML-escapes all dynamic content to prevent XSS (Senior B-5).
 * Browser: Pure ES module, zero build steps, zero dependencies (Senior B-2).
 */

/**
 * Escapes special HTML characters in a string to prevent XSS.
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the dashboard overview tiles and metrics grid.
 * @param {import('../contract.ts').DashboardDTO} dto
 * @returns {string}
 */
export function renderDashboardTileGrid(dto) {
  if (!dto) {
    return '<div class="card empty-state">No dashboard data available</div>';
  }

  const populations = (dto.statePopulations || [])
    .map(sp => `
      <div class="pop-pill">
        <span class="pop-label">${escapeHtml(sp.state)}</span>
        <span class="pop-count">${escapeHtml(sp.count)}</span>
      </div>
    `)
    .join('');

  const failureRatePercent = dto.verifyFailureRate
    ? (dto.verifyFailureRate.failure_rate * 100).toFixed(1)
    : '0.0';

  const budgetRows = (dto.budgetSpend || [])
    .map(b => `
      <tr>
        <td><code>${escapeHtml(b.task_id)}</code></td>
        <td>${escapeHtml(b.title)}</td>
        <td><span class="badge state-${escapeHtml(b.state)}">${escapeHtml(b.state)}</span></td>
        <td>${escapeHtml(b.plan_rounds)}</td>
        <td>${escapeHtml(b.verify_fixes)}</td>
        <td>${escapeHtml(b.cycles)}</td>
        <td>${escapeHtml(b.attempts)}</td>
      </tr>
    `)
    .join('');

  return `
    <div class="dashboard-grid">
      <div class="card stat-card">
        <h3>Task State Populations</h3>
        <div class="pop-grid">${populations || '<em>No tasks</em>'}</div>
      </div>

      <div class="card stat-card">
        <h3>Verification Health</h3>
        <div class="metric-group">
          <div class="metric-val">${escapeHtml(failureRatePercent)}%</div>
          <div class="metric-sub">${escapeHtml(dto.verifyFailureRate?.failures || 0)} failures / ${escapeHtml(dto.verifyFailureRate?.total_runs || 0)} total runs</div>
        </div>
      </div>

      <div class="card stat-card">
        <h3>Guardrail Refusals</h3>
        <div class="metric-group">
          <div class="metric-val text-warning">${escapeHtml(dto.guardrailCount || 0)}</div>
          <div class="metric-sub">Total fail-closed interventions</div>
        </div>
      </div>

      <div class="card table-card full-width">
        <h3>Task Budget Spend</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>Task ID</th>
              <th>Title</th>
              <th>State</th>
              <th>Plan Rounds</th>
              <th>Verify Fixes</th>
              <th>Cycles</th>
              <th>Attempts</th>
            </tr>
          </thead>
          <tbody>
            ${budgetRows || '<tr><td colspan="7" class="text-center">No active budget spend recorded</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Renders the task table view with action triggers.
 * @param {import('../contract.ts').TaskSummaryDTO[]} tasks
 * @returns {string}
 */
export function renderTaskTable(tasks) {
  if (!tasks || tasks.length === 0) {
    return '<div class="card empty-state">No tasks recorded in bureau</div>';
  }

  const rows = tasks.map(t => {
    const isApproveable = t.state === 'verifying' && t.verifier_exit_code === 0 && !t.approved_at;
    const approveBtn = isApproveable
      ? `<button class="btn btn-primary btn-sm btn-approve" data-task-id="${escapeHtml(t.id)}">Approve</button>`
      : (t.approved_at ? `<span class="text-muted">Approved by ${escapeHtml(t.approved_by || 'human')}</span>` : '-');

    const prLink = t.pull_request_url
      ? `<a href="${escapeHtml(t.pull_request_url)}" target="_blank" rel="noopener">PR</a>`
      : '-';

    return `
      <tr data-task-id="${escapeHtml(t.id)}">
        <td><code>${escapeHtml(t.id)}</code></td>
        <td class="task-title-cell">${escapeHtml(t.title)}</td>
        <td><span class="badge state-${escapeHtml(t.state)}">${escapeHtml(t.state)}</span></td>
        <td>${t.verifier_exit_code !== null ? `<code>code ${escapeHtml(t.verifier_exit_code)}</code>` : '-'}</td>
        <td>${escapeHtml(t.plan_rounds)} / ${escapeHtml(t.verify_fixes)}</td>
        <td>${prLink}</td>
        <td>${approveBtn}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>State</th>
            <th>Verifier</th>
            <th>Rounds / Fixes</th>
            <th>PR</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Renders active watchdog findings.
 * @param {import('../contract.ts').FindingDTO[]} findings
 * @returns {string}
 */
export function renderFindingsList(findings) {
  if (!findings || findings.length === 0) {
    return '<div class="card empty-state">Zero active watchdog findings. Bureau healthy.</div>';
  }

  const items = findings.map(f => `
    <div class="finding-item status-${escapeHtml(f.status)}" data-finding-id="${escapeHtml(f.id)}">
      <div class="finding-header">
        <span class="badge badge-finding">${escapeHtml(f.finding_class)}</span>
        <span class="finding-subject">Subject: <code>${escapeHtml(f.subject_kind || 'system')}:${escapeHtml(f.subject_id || f.task_id || 'root')}</code></span>
        <span class="finding-time">${escapeHtml(f.detected_at)}</span>
      </div>
      <div class="finding-detail">${escapeHtml(f.detail || 'No details recorded')}</div>
      <div class="finding-footer">
        <span>Status: <strong>${escapeHtml(f.status)}</strong></span>
        <span>Recovery Attempts: ${escapeHtml(f.recover_attempts)}</span>
        ${f.recovery_job_id ? `<span>Recovery Job: <code>${escapeHtml(f.recovery_job_id)}</code></span>` : ''}
      </div>
    </div>
  `).join('');

  return `<div class="findings-list">${items}</div>`;
}

/**
 * Renders the department worker/employee roster with active status.
 * @param {import('../contract.ts').WorkerDTO[]} workers
 * @returns {string}
 */
export function renderWorkers(workers) {
  if (!workers || workers.length === 0) {
    return '<div class="card empty-state">No workers on record yet.</div>';
  }
  const activeCount = workers.filter(w => w.active).length;
  const rows = workers.map(w => {
    const dot = w.active ? '<span class="worker-dot active" title="Active"></span>' : '<span class="worker-dot idle" title="Idle"></span>';
    const status = w.active ? 'Working' : 'Idle';
    const doing = w.running_dispatches > 0 ? `${w.running_dispatches} dispatch(es)` : (w.active_leases > 0 ? `${w.active_leases} lease(s)` : '—');
    const model = w.display || w.model_id || (w.backend ? escapeHtml(w.backend) : 'deterministic / core');
    const last = w.last_activity_ts ? `${escapeHtml(w.last_activity_kind || '')} @ ${escapeHtml(w.last_activity_ts)}` : 'never';
    return `
      <tr class="worker-row ${w.active ? 'is-active' : ''}">
        <td>${dot} <strong>${escapeHtml(w.role)}</strong></td>
        <td>${escapeHtml(model)}${w.provider ? ` <span class="badge">${escapeHtml(w.provider)}</span>` : ''}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(doing)}</td>
        <td class="worker-last">${last}</td>
      </tr>`;
  }).join('');
  return `
    <div class="workers-summary">${escapeHtml(activeCount)} of ${escapeHtml(workers.length)} workers active</div>
    <table class="worker-table">
      <thead><tr><th>Worker</th><th>Model / backend</th><th>Status</th><th>Doing</th><th>Last activity</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Renders the journal timeline entries.
 * @param {import('../contract.ts').JournalEntryDTO[]} journal
 * @returns {string}
 */
export function renderJournalTimeline(journal) {
  if (!journal || journal.length === 0) {
    return '<div class="card empty-state">No journal entries found</div>';
  }

  const items = journal.map(j => `
    <div class="timeline-item kind-${escapeHtml(j.kind)}">
      <div class="timeline-meta">
        <span class="timeline-ts">${escapeHtml(j.ts)}</span>
        <span class="badge kind-${escapeHtml(j.kind)}">${escapeHtml(j.kind)}</span>
        <span class="actor">${escapeHtml(j.actor_role)} (${escapeHtml(j.provider)})</span>
      </div>
      <div class="timeline-body">
        <div class="timeline-detail">${escapeHtml(j.detail)}</div>
        ${j.task_id ? `<div class="timeline-sub">Task: <code>${escapeHtml(j.task_id)}</code></div>` : ''}
      </div>
    </div>
  `).join('');

  return `<div class="timeline">${items}</div>`;
}

/**
 * Renders a fail-closed re-launch banner when authentication fails (401).
 * @param {string} [reason]
 * @returns {string}
 */
export function renderRelaunchState(reason) {
  return `
    <div class="relaunch-container">
      <div class="card relaunch-card">
        <div class="relaunch-icon">🔒</div>
        <h2>Console Authentication Required</h2>
        <p>${escapeHtml(reason || 'Session token missing, expired, or invalid.')}</p>
        <p class="relaunch-help">Please re-launch the Operator Console from your desktop shortcut or run:</p>
        <pre>npm run console</pre>
      </div>
    </div>
  `;
}

/**
 * Renders error toast notification.
 * @param {import('../contract.ts').ApiErrorResponse | string} error
 * @returns {string}
 */
export function renderErrorToast(error) {
  if (typeof error === 'string') {
    return `<div class="toast toast-error"><span class="toast-icon">⚠️</span> ${escapeHtml(error)}</div>`;
  }
  const msg = error?.error || 'An error occurred';
  const code = error?.code ? ` [${error.code}]` : '';
  return `<div class="toast toast-error"><span class="toast-icon">🛑</span> <strong>${escapeHtml(msg)}</strong>${escapeHtml(code)}</div>`;
}

/**
 * Renders the console settings view.
 * @param {{ theme?: string, isPaused?: boolean, hasToken?: boolean, tokenPreview?: string }} [settings]
 * @returns {string}
 */
export function renderSettings(settings = {}) {
  const theme = escapeHtml(settings.theme || 'dark');
  const pollStatus = settings.isPaused ? 'Paused' : 'Active (5s interval)';
  const token = settings.tokenPreview
    ? escapeHtml(settings.tokenPreview)
    : (settings.hasToken ? 'Active' : 'Not configured');

  return `
    <div class="dashboard-grid">
      <div class="card stat-card">
        <h3>Operator Session</h3>
        <div class="metric-group">
          <div class="metric-sub">Session Token: <code>${token}</code></div>
          <div class="metric-sub">UI Theme: <strong>${theme}</strong></div>
        </div>
      </div>

      <div class="card stat-card">
        <h3>Console Polling</h3>
        <div class="metric-group">
          <div class="metric-sub">Interval: <strong>5000ms</strong></div>
          <div class="metric-sub">State: <strong>${escapeHtml(pollStatus)}</strong></div>
        </div>
      </div>

      <div class="card table-card full-width">
        <h3>Console Configuration & Status</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Current Value</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>AUTO_REFRESH_INTERVAL</code></td>
              <td><code>5000ms</code></td>
              <td>Background polling interval for active views</td>
            </tr>
            <tr>
              <td><code>THEME</code></td>
              <td><code>${theme}</code></td>
              <td>Active color theme (Dark / Light toggle)</td>
            </tr>
            <tr>
              <td><code>SESSION_AUTH</code></td>
              <td><code>${token}</code></td>
              <td>Authenticated x-console-token header status</td>
            </tr>
            <tr>
              <td><code>ENVIRONMENT</code></td>
              <td><code>Department of Code v2</code></td>
              <td>Autonomous Bureau Operator Console</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}
