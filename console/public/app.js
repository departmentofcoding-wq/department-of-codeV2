import {
  renderDashboardTileGrid,
  renderTaskTable,
  renderFindingsList,
  renderWorkers,
  renderJournalTimeline,
  renderSettings,
  renderRelaunchState,
  renderErrorToast
} from './render.js';

// --- State Management ---
let consoleToken = null;
let activeTab = 'dashboard';
let isPaused = false;
let pollTimer = null;
let pendingConfirmAction = null;

// --- Token Initialization ---
function initAuthToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const queryToken = urlParams.get('token');

  if (queryToken) {
    consoleToken = queryToken;
    sessionStorage.setItem('x-console-token', queryToken);
    // Clean token from address bar (Good practice confirmed in Senior review)
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', cleanUrl);
  } else {
    consoleToken = sessionStorage.getItem('x-console-token');
  }
}

// --- Authenticated Fetch Wrapper ---
export async function apiFetch(path, options = {}) {
  if (!consoleToken) {
    showRelaunchState('No authentication token provided.');
    throw new Error('Authentication required');
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-console-token': consoleToken,
    ...(options.headers || {})
  };

  try {
    const res = await fetch(path, { ...options, headers });

    if (res.status === 401) {
      showRelaunchState('Authentication failed or session token expired (401).');
      throw new Error('Unauthorized');
    }

    const data = await res.json();
    if (!res.ok) {
      const errReason = data?.error || `HTTP ${res.status}`;
      showToast(renderErrorToast(data));
      throw new Error(errReason);
    }

    return data;
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      showToast(renderErrorToast(err.message));
    }
    throw err;
  }
}

// --- UI View Renderers ---
function showRelaunchState(reason) {
  if (pollTimer) clearInterval(pollTimer);
  document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
  const relaunchEl = document.getElementById('relaunch-view');
  if (relaunchEl) {
    relaunchEl.innerHTML = renderRelaunchState(reason);
    relaunchEl.classList.add('active');
  }
}

async function loadDashboardView() {
  const container = document.getElementById('dashboard-container');
  try {
    const data = await apiFetch('/api/dashboard');
    container.innerHTML = renderDashboardTileGrid(data);
  } catch (e) {
    // Error handled in apiFetch
  }
}

async function loadTasksView() {
  const container = document.getElementById('tasks-container');
  try {
    const tasks = await apiFetch('/api/tasks');
    container.innerHTML = renderTaskTable(tasks);
    attachTaskActionListeners();
  } catch (e) {
    // Error handled in apiFetch
  }
}

async function loadFindingsView() {
  const container = document.getElementById('findings-container');
  try {
    const findings = await apiFetch('/api/findings');
    container.innerHTML = renderFindingsList(findings);
  } catch (e) {
    // Error handled in apiFetch
  }
}

async function loadWorkersView() {
  const container = document.getElementById('workers-container');
  try {
    const workers = await apiFetch('/api/workers');
    container.innerHTML = renderWorkers(workers);
  } catch (e) {
    // Error handled in apiFetch
  }
}

async function loadJournalView() {
  const container = document.getElementById('journal-container');
  try {
    const journal = await apiFetch('/api/journal');
    container.innerHTML = renderJournalTimeline(journal);
  } catch (e) {
    // Error handled in apiFetch
  }
}

function loadSettingsView() {
  const container = document.getElementById('settings-container');
  if (!container) return;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const tokenPreview = consoleToken ? `${consoleToken.slice(0, 8)}...` : undefined;
  container.innerHTML = renderSettings({
    theme,
    isPaused,
    hasToken: Boolean(consoleToken),
    tokenPreview
  });
}

async function refreshActiveView() {
  if (isPaused) return;

  const updatedEl = document.getElementById('last-updated');
  if (updatedEl) {
    updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  switch (activeTab) {
    case 'dashboard':
      await loadDashboardView();
      break;
    case 'tasks':
      await loadTasksView();
      break;
    case 'findings':
      await loadFindingsView();
      break;
    case 'workers':
      await loadWorkersView();
      break;
    case 'journal':
      await loadJournalView();
      break;
    case 'settings':
      loadSettingsView();
      break;
  }
}

// --- Action Triggers & Listeners ---
function attachTaskActionListeners() {
  document.querySelectorAll('.btn-approve').forEach(btn => {
    btn.addEventListener('click', e => {
      const taskId = e.target.getAttribute('data-task-id');
      promptConfirm(
        'Approve Task Verification',
        `Are you sure you want to approve task ${taskId}? This action will record human-operator approval.`,
        async () => {
          try {
            const res = await apiFetch(`/api/tasks/${taskId}/approve`, {
              method: 'POST',
              body: JSON.stringify({ approvedBy: 'human-operator' })
            });
            showToast(`<div class="toast"><span class="toast-icon">✅</span> Task ${taskId} approved successfully</div>`);
            await refreshActiveView();
          } catch (err) {
            // Guardrail error toast handled by apiFetch
          }
        }
      );
    });
  });
}

function promptConfirm(title, bodyText, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = bodyText;
  pendingConfirmAction = onConfirm;
  modal.classList.remove('hidden');
}

function closeModal() {
  const modal = document.getElementById('confirm-modal');
  modal.classList.add('hidden');
  pendingConfirmAction = null;
}

function showToast(htmlString) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = htmlString;
  const toastEl = div.firstElementChild;
  container.appendChild(toastEl);
  setTimeout(() => {
    toastEl.remove();
  }, 4000);
}

// --- Event Handlers & Bootstrap ---
function setupEventListeners() {
  // Navigation tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));

      e.target.classList.add('active');
      activeTab = e.target.getAttribute('data-view');
      const viewEl = document.getElementById(`view-${activeTab}`);
      if (viewEl) viewEl.classList.add('active');

      refreshActiveView();
    });
  });

  // Pause / Resume toggle
  const pauseBtn = document.getElementById('pause-toggle');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? '▶️ Paused' : '⏸️ Live';
    });
  }

  // Theme toggle
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', newTheme);
    });
  }

  // Modal actions
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-confirm-btn')?.addEventListener('click', async () => {
    if (pendingConfirmAction) {
      const act = pendingConfirmAction;
      closeModal();
      await act();
    }
  });

  // Action buttons
  document.getElementById('trigger-sweep-btn')?.addEventListener('click', () => {
    promptConfirm('Trigger Watchdog Sweep', 'Enqueue a watchdog.sweep background job?', async () => {
      try {
        const res = await apiFetch('/api/actions/trigger', {
          method: 'POST',
          body: JSON.stringify({ kind: 'watchdog.sweep' })
        });
        showToast(`<div class="toast"><span class="toast-icon">🧹</span> Enqueued watchdog.sweep job (${res.job_id})</div>`);
      } catch (err) {}
    });
  });

  document.getElementById('trigger-backup-btn')?.addEventListener('click', () => {
    promptConfirm('Trigger Backup Push', 'Enqueue a backup.push background job?', async () => {
      try {
        const res = await apiFetch('/api/actions/trigger', {
          method: 'POST',
          body: JSON.stringify({ kind: 'backup.push' })
        });
        showToast(`<div class="toast"><span class="toast-icon">💾</span> Enqueued backup.push job (${res.job_id})</div>`);
      } catch (err) {}
    });
  });
}

function bootstrap() {
  initAuthToken();
  if (!consoleToken) {
    showRelaunchState('No token found in launch URL or storage.');
    return;
  }

  setupEventListeners();
  refreshActiveView();
  pollTimer = setInterval(refreshActiveView, 5000);
}

// Auto-run bootstrap on DOM load if running in browser
if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  bootstrap();
} else if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', bootstrap);
}
