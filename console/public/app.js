import {
  renderDashboardTileGrid,
  renderTaskTable,
  renderArchivedTaskTable,
  renderCompletedTaskTable,
  renderFlowPipeline,
  renderFindingsList,
  renderWorkers,
  renderAssetsTable,
  renderProjectsTable,
  renderJournalTimeline,
  renderSettings,
  renderRelaunchState,
  renderErrorToast,
  renderIntakeConversation,
  renderIntakeDraft
} from './render.js';

// --- State Management ---
let consoleToken = null;
let activeTab = 'dashboard';
let isPaused = false;
let pollTimer = null;
let pendingConfirmAction = null;
let currentIntakeSessionId = null;
let intakeBusy = false;
let currentAssets = [];
// Which Tasks bucket is shown: 'live' (active work), 'completed' (shipped/done),
// or 'archived' (set aside).
let tasksView = 'live';

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

function syncTasksViewButtons() {
  const map = { live: 'tab-tasks-live', completed: 'tab-tasks-completed', archived: 'tab-tasks-archived' };
  for (const [view, id] of Object.entries(map)) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', tasksView === view);
  }
}

async function loadTasksView() {
  const container = document.getElementById('tasks-container');
  syncTasksViewButtons();
  try {
    if (tasksView === 'archived') {
      const tasks = await apiFetch('/api/tasks/archived');
      container.innerHTML = renderArchivedTaskTable(tasks);
      attachArchivedActionListeners();
    } else if (tasksView === 'completed') {
      const tasks = await apiFetch('/api/tasks/completed');
      container.innerHTML = renderCompletedTaskTable(tasks);
      attachCompletedActionListeners();
    } else {
      const tasks = await apiFetch('/api/tasks');
      container.innerHTML = renderTaskTable(tasks);
      attachTaskActionListeners();
    }
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
  const flowContainer = document.getElementById('flow-container');
  const container = document.getElementById('workers-container');
  try {
    const [flowRes, workersRes] = await Promise.allSettled([
      apiFetch('/api/flow'),
      apiFetch('/api/workers')
    ]);
    if (flowContainer && flowRes.status === 'fulfilled') {
      flowContainer.innerHTML = renderFlowPipeline(flowRes.value);
    }
    if (workersRes.status === 'fulfilled') {
      container.innerHTML = renderWorkers(workersRes.value);
    }
  } catch (e) {
    // Error handled in apiFetch
  }
}

async function loadAssetsView() {
  const container = document.getElementById('assets-container');
  try {
    const assets = await apiFetch('/api/assets');
    currentAssets = assets;
    container.innerHTML = renderAssetsTable(assets);
    attachAssetActionListeners();
  } catch (e) {
    // Error handled in apiFetch
  }
}

async function loadProjectsView() {
  const container = document.getElementById('projects-container');
  if (!container) return;
  try {
    const projects = await apiFetch('/api/projects');
    container.innerHTML = renderProjectsTable(projects);
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

async function loadSettingsView() {
  const container = document.getElementById('settings-container');
  if (!container) return;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const tokenPreview = consoleToken ? `${consoleToken.slice(0, 8)}...` : undefined;

  let googleKeys = { count: 0, masked: [] };
  let ntfySettings = { ntfy_server_url: 'https://ntfy.sh', ntfy_topic: '', enabled: false, events: [] };
  try {
    const [keysRes, ntfyRes] = await Promise.allSettled([
      apiFetch('/api/settings/google-keys'),
      apiFetch('/api/settings/ntfy')
    ]);
    if (keysRes.status === 'fulfilled') googleKeys = keysRes.value;
    if (ntfyRes.status === 'fulfilled') ntfySettings = ntfyRes.value;
  } catch (e) {
    // Non-fatal; render with empty status.
  }

  container.innerHTML = renderSettings({
    theme,
    isPaused,
    hasToken: Boolean(consoleToken),
    tokenPreview,
    googleKeys,
    ntfySettings
  });

  document.getElementById('save-google-keys-btn')?.addEventListener('click', saveGoogleKeys);
  document.getElementById('save-ntfy-settings-btn')?.addEventListener('click', saveNtfySettings);
  document.getElementById('test-ntfy-btn')?.addEventListener('click', sendTestNtfy);
}

async function sendTestNtfy() {
  const btn = document.getElementById('test-ntfy-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res = await apiFetch('/api/settings/ntfy/test', { method: 'POST', body: JSON.stringify({}) });
    if (res.ok) {
      showToast(`<div class="toast"><span class="toast-icon">🔔</span> Test notification sent — check your device</div>`);
    } else if (!res.configured) {
      showToast(renderErrorToast('No ntfy topic configured. Save a topic first, then send a test.'));
    } else {
      showToast(renderErrorToast('ntfy did not accept the test push. Check the server URL and topic.'));
    }
  } catch (err) {
    // Error toast handled by apiFetch.
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send test'; }
  }
}

async function saveGoogleKeys() {
  const k1 = document.getElementById('google-key-1')?.value.trim() || '';
  const k2 = document.getElementById('google-key-2')?.value.trim() || '';
  const keys = [k1, k2].filter(Boolean);
  if (keys.length === 0) {
    showToast(renderErrorToast('Enter at least one Google API key.'));
    return;
  }
  try {
    const res = await apiFetch('/api/settings/google-keys', {
      method: 'POST',
      body: JSON.stringify({ keys })
    });
    showToast(`<div class="toast"><span class="toast-icon">🔑</span> Saved ${res.count} Google key(s)</div>`);
    await loadSettingsView();
  } catch (err) {
    // Error toast handled by apiFetch.
  }
}

async function saveNtfySettings() {
  const ntfy_server_url = document.getElementById('ntfy-server-url')?.value.trim() || 'https://ntfy.sh';
  const ntfy_topic = document.getElementById('ntfy-topic')?.value.trim() || '';

  try {
    const res = await apiFetch('/api/settings/ntfy', {
      method: 'POST',
      body: JSON.stringify({ ntfy_server_url, ntfy_topic })
    });
    const topicMsg = res.ntfy_topic ? `topic "${res.ntfy_topic}"` : 'push notifications disabled';
    showToast(`<div class="toast"><span class="toast-icon">🔔</span> Saved Ntfy settings (${topicMsg})</div>`);
    await loadSettingsView();
  } catch (err) {
    // Error toast handled by apiFetch.
  }
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
    case 'assets':
      await loadAssetsView();
      break;
    case 'projects':
      await loadProjectsView();
      break;
    case 'journal':
      await loadJournalView();
      break;
    case 'settings':
      await loadSettingsView();
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

  document.querySelectorAll('.btn-complete').forEach(btn => {
    btn.addEventListener('click', e => {
      const taskId = e.currentTarget.getAttribute('data-task-id');
      promptConfirm(
        'Mark Task Completed',
        `Tag task ${taskId} as completed / shipped? It moves to the Completed list (state unchanged) and can be reopened anytime.`,
        async () => {
          try {
            await apiFetch(`/api/tasks/${taskId}/complete`, {
              method: 'POST',
              body: JSON.stringify({ note: 'Marked complete from console' })
            });
            showToast(`<div class="toast"><span class="toast-icon">✅</span> Task ${taskId} marked completed</div>`);
            await refreshActiveView();
          } catch (err) {
            // Error toast handled by apiFetch
          }
        }
      );
    });
  });

  document.querySelectorAll('.btn-archive').forEach(btn => {
    btn.addEventListener('click', e => {
      const taskId = e.currentTarget.getAttribute('data-task-id');
      promptConfirm(
        'Archive Task',
        `Set task ${taskId} aside? It moves to the archived list (state unchanged) and can be restored anytime.`,
        async () => {
          try {
            await apiFetch(`/api/tasks/${taskId}/archive`, {
              method: 'POST',
              body: JSON.stringify({ reason: 'Archived from console' })
            });
            showToast(`<div class="toast"><span class="toast-icon">🗄️</span> Task ${taskId} archived</div>`);
            await refreshActiveView();
          } catch (err) {
            // Error toast handled by apiFetch
          }
        }
      );
    });
  });
}

function attachCompletedActionListeners() {
  document.querySelectorAll('.btn-reopen').forEach(btn => {
    btn.addEventListener('click', e => {
      const taskId = e.currentTarget.getAttribute('data-task-id');
      promptConfirm(
        'Reopen Task',
        `Clear the completed tag on task ${taskId} and return it to the live task list?`,
        async () => {
          try {
            await apiFetch(`/api/tasks/${taskId}/reopen`, { method: 'POST' });
            showToast(`<div class="toast"><span class="toast-icon">♻️</span> Task ${taskId} reopened</div>`);
            await refreshActiveView();
          } catch (err) {
            // Error toast handled by apiFetch
          }
        }
      );
    });
  });
}

function attachArchivedActionListeners() {
  document.querySelectorAll('.btn-unarchive').forEach(btn => {
    btn.addEventListener('click', e => {
      const taskId = e.currentTarget.getAttribute('data-task-id');
      promptConfirm(
        'Restore Task',
        `Bring task ${taskId} back to the live task list?`,
        async () => {
          try {
            await apiFetch(`/api/tasks/${taskId}/unarchive`, { method: 'POST' });
            showToast(`<div class="toast"><span class="toast-icon">♻️</span> Task ${taskId} restored</div>`);
            await refreshActiveView();
          } catch (err) {
            // Error toast handled by apiFetch
          }
        }
      );
    });
  });
}

function attachAssetActionListeners() {
  document.querySelectorAll('.btn-edit-asset').forEach(btn => {
    btn.addEventListener('click', e => {
      const assetId = e.currentTarget.getAttribute('data-id');
      const asset = currentAssets.find(a => a.id === assetId);
      if (asset) openAssetModal(asset);
    });
  });

  document.querySelectorAll('.btn-delete-asset').forEach(btn => {
    btn.addEventListener('click', e => {
      const assetId = e.currentTarget.getAttribute('data-id');
      const asset = currentAssets.find(a => a.id === assetId);
      const assetName = asset ? asset.name : assetId;
      promptConfirm(
        'Delete Department Asset',
        `Are you sure you want to delete asset "${assetName}"? This action cannot be undone.`,
        async () => {
          try {
            await apiFetch(`/api/assets/${assetId}/delete`, {
              method: 'POST'
            });
            showToast(`<div class="toast"><span class="toast-icon">🗑️</span> Asset deleted successfully</div>`);
            await loadAssetsView();
          } catch (err) {
            // Error toast handled by apiFetch
          }
        }
      );
    });
  });
}

function openAssetModal(asset = null) {
  const modal = document.getElementById('asset-modal');
  const title = document.getElementById('asset-modal-title');
  const idInput = document.getElementById('asset-form-id');
  const nameInput = document.getElementById('asset-form-name');
  const categorySelect = document.getElementById('asset-form-category');
  const urlInput = document.getElementById('asset-form-url');
  const descInput = document.getElementById('asset-form-description');
  const ownerInput = document.getElementById('asset-form-owner');
  const statusSelect = document.getElementById('asset-form-status');

  if (asset) {
    if (title) title.textContent = 'Edit Department Asset';
    if (idInput) idInput.value = asset.id;
    if (nameInput) nameInput.value = asset.name;
    if (categorySelect) categorySelect.value = asset.category || 'Other';
    if (urlInput) urlInput.value = asset.url;
    if (descInput) descInput.value = asset.description || '';
    if (ownerInput) ownerInput.value = asset.owner || '';
    if (statusSelect) statusSelect.value = asset.status || 'Active';
  } else {
    if (title) title.textContent = 'Add Department Asset';
    if (idInput) idInput.value = '';
    if (nameInput) nameInput.value = '';
    if (categorySelect) categorySelect.value = 'Other';
    if (urlInput) urlInput.value = '';
    if (descInput) descInput.value = '';
    if (ownerInput) ownerInput.value = '';
    if (statusSelect) statusSelect.value = 'Active';
  }

  if (modal) modal.classList.remove('hidden');
  if (nameInput) nameInput.focus();
}

function closeAssetModal() {
  document.getElementById('asset-modal')?.classList.add('hidden');
}

async function saveAssetForm(e) {
  e.preventDefault();
  const id = document.getElementById('asset-form-id')?.value;
  const name = document.getElementById('asset-form-name')?.value.trim();
  const category = document.getElementById('asset-form-category')?.value;
  const url = document.getElementById('asset-form-url')?.value.trim();
  const description = document.getElementById('asset-form-description')?.value.trim() || undefined;
  const owner = document.getElementById('asset-form-owner')?.value.trim() || undefined;
  const status = document.getElementById('asset-form-status')?.value;

  if (!name || !url) {
    showToast(renderErrorToast('Asset Name and URL are required.'));
    return;
  }

  try {
    if (id) {
      await apiFetch(`/api/assets/${id}/update`, {
        method: 'POST',
        body: JSON.stringify({ name, category, url, description, owner, status })
      });
      showToast(`<div class="toast"><span class="toast-icon">✅</span> Asset updated successfully</div>`);
    } else {
      await apiFetch('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ name, category, url, description, owner, status })
      });
      showToast(`<div class="toast"><span class="toast-icon">✅</span> Asset created successfully</div>`);
    }
    closeAssetModal();
    await loadAssetsView();
  } catch (err) {
    // Error toast handled by apiFetch
  }
}

// --- Projects ---
function openProjectModal() {
  const modal = document.getElementById('project-modal');
  const nameInput = document.getElementById('project-form-name');
  const pathInput = document.getElementById('project-form-path');
  const descInput = document.getElementById('project-form-description');
  if (nameInput) nameInput.value = '';
  if (pathInput) pathInput.value = '';
  if (descInput) descInput.value = '';
  if (modal) modal.classList.remove('hidden');
  if (nameInput) nameInput.focus();
}

function closeProjectModal() {
  document.getElementById('project-modal')?.classList.add('hidden');
}

async function saveProjectForm(e) {
  e.preventDefault();
  const name = document.getElementById('project-form-name')?.value.trim();
  const pathToRepo = document.getElementById('project-form-path')?.value.trim();
  const description = document.getElementById('project-form-description')?.value.trim() || undefined;

  if (!name || !pathToRepo) {
    showToast(renderErrorToast('Project Name and Folder Location are required.'));
    return;
  }

  try {
    await apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, pathToRepo, description })
    });
    showToast(`<div class="toast"><span class="toast-icon">📁</span> Project "${name}" registered</div>`);
    closeProjectModal();
    await loadProjectsView();
  } catch (err) {
    // Error toast handled by apiFetch (e.g. path not found / not a git repo)
  }
}

// --- Conversational Intake ---
function openIntake() {
  currentIntakeSessionId = null;
  const modal = document.getElementById('intake-modal');
  document.getElementById('intake-conversation').innerHTML = renderIntakeConversation(null);
  const draft = document.getElementById('intake-draft');
  draft.innerHTML = '';
  draft.classList.add('hidden');
  const input = document.getElementById('intake-input');
  input.value = '';
  input.disabled = false;
  modal.classList.remove('hidden');
  input.focus();
}

function closeIntake() {
  document.getElementById('intake-modal')?.classList.add('hidden');
  currentIntakeSessionId = null;
}

function setIntakeBusy(busy) {
  intakeBusy = busy;
  const input = document.getElementById('intake-input');
  const sendBtn = document.getElementById('intake-send-btn');
  if (input) input.disabled = busy;
  if (sendBtn) {
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? 'Thinking…' : 'Send';
  }
}

function renderIntakeState(state) {
  currentIntakeSessionId = state.session_id;
  document.getElementById('intake-conversation').innerHTML = renderIntakeConversation(state);
  const draft = document.getElementById('intake-draft');
  const draftHtml = renderIntakeDraft(state);
  draft.innerHTML = draftHtml;
  draft.classList.toggle('hidden', !draftHtml);

  // Scroll conversation to the newest turn.
  const convo = document.getElementById('intake-conversation');
  convo.scrollTop = convo.scrollHeight;

  // Wire the file button when the verify gate is ready.
  const fileBtn = document.getElementById('intake-file-btn');
  if (fileBtn) fileBtn.addEventListener('click', fileIntakeTask);
}

async function sendIntakeMessage() {
  if (intakeBusy) return;
  const input = document.getElementById('intake-input');
  const text = input.value.trim();
  if (!text) return;

  setIntakeBusy(true);
  try {
    let state;
    if (!currentIntakeSessionId) {
      state = await apiFetch('/api/intake', {
        method: 'POST',
        body: JSON.stringify({ prompt: text })
      });
    } else {
      state = await apiFetch(`/api/intake/${currentIntakeSessionId}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });
    }
    input.value = '';
    renderIntakeState(state);
  } catch (err) {
    // Toast handled by apiFetch; keep the panel open so the operator can retry.
  } finally {
    setIntakeBusy(false);
    input.focus();
  }
}

async function fileIntakeTask() {
  if (!currentIntakeSessionId || intakeBusy) return;
  setIntakeBusy(true);
  try {
    const res = await apiFetch(`/api/intake/${currentIntakeSessionId}/confirm-file`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    showToast(`<div class="toast"><span class="toast-icon">✅</span> Task filed: ${res.task_id}</div>`);
    closeIntake();
    await refreshActiveView();
  } catch (err) {
    // Toast handled by apiFetch.
  } finally {
    setIntakeBusy(false);
  }
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

  // Tasks: switch between the live / completed / archived buckets.
  document.getElementById('tab-tasks-live')?.addEventListener('click', () => {
    tasksView = 'live';
    loadTasksView();
  });
  document.getElementById('tab-tasks-completed')?.addEventListener('click', () => {
    tasksView = 'completed';
    loadTasksView();
  });
  document.getElementById('tab-tasks-archived')?.addEventListener('click', () => {
    tasksView = 'archived';
    loadTasksView();
  });

  // Conversational intake
  document.getElementById('new-task-btn')?.addEventListener('click', openIntake);
  document.getElementById('intake-close-btn')?.addEventListener('click', closeIntake);
  document.getElementById('intake-send-btn')?.addEventListener('click', sendIntakeMessage);
  document.getElementById('intake-input')?.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendIntakeMessage();
    }
  });

  // Department Assets modal & form
  document.getElementById('new-asset-btn')?.addEventListener('click', () => openAssetModal(null));
  document.getElementById('asset-modal-close-btn')?.addEventListener('click', closeAssetModal);
  document.getElementById('asset-modal-cancel-btn')?.addEventListener('click', closeAssetModal);
  document.getElementById('asset-form')?.addEventListener('submit', saveAssetForm);

  // Projects modal & form
  document.getElementById('new-project-btn')?.addEventListener('click', openProjectModal);
  document.getElementById('project-modal-close-btn')?.addEventListener('click', closeProjectModal);
  document.getElementById('project-modal-cancel-btn')?.addEventListener('click', closeProjectModal);
  document.getElementById('project-form')?.addEventListener('submit', saveProjectForm);

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
