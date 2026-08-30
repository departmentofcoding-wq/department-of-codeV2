/**
 * Console API Contract (Milestone D0-C)
 *
 * Frozen DTOs, endpoint manifest, and security constants shared by Stream A
 * (Backend API server) and Stream B (Frontend & Launcher).
 *
 * Rule: Zero runtime dependencies. Keep this file pure types and constants so both
 * server and client suites can import it without side effects or platform bindings.
 */

// --- Security & Server Constants ---

/** Bind host address for local-only security posture. MUST be 127.0.0.1 (never 0.0.0.0). */
export const CONSOLE_BIND_HOST = '127.0.0.1';

/** HTTP Header name for per-launch authentication token (normalized lowercase for node:http). */
export const CONSOLE_TOKEN_HEADER = 'x-console-token';

/** Query parameter name for initial token handoff on page launch. */
export const CONSOLE_QUERY_TOKEN_PARAM = 'token';

/** Default fallback port for local web console server. */
export const CONSOLE_DEFAULT_PORT = 3100;

/** Size cap (bytes) for JSON request payloads (1MB). */
export const MAX_JSON_BODY_BYTES = 1_048_576;


// --- Read DTOs ---

export interface HealthDTO {
  ok: boolean;
  timestamp: string;
  uptime_ms: number;
}

export interface StatePopulationDTO {
  state: string;
  count: number;
}

export interface TaskBudgetSpendDTO {
  task_id: string;
  title: string;
  state: string;
  plan_rounds: number;
  verify_fixes: number;
  cycles: number;
  attempts: number;
  recover_attempts: number;
}

export interface VerifyFailureRateDTO {
  total_runs: number;
  failures: number;
  failure_rate: number;
}

export interface SpanKindCountDTO {
  kind: string;
  count: number;
}

/** Dashboard snapshot DTO (wraps B2 views). */
export interface DashboardDTO {
  statePopulations: StatePopulationDTO[];
  budgetSpend: TaskBudgetSpendDTO[];
  verifyFailureRate: VerifyFailureRateDTO;
  spanKindCounts: SpanKindCountDTO[];
  guardrailCount: number;
}

/** Task summary DTO (maps bureau_tasks columns). */
export interface TaskSummaryDTO {
  id: string;
  title: string;
  state: string;
  verifier_exit_code: number | null;
  approved_at: string | null;
  approved_by: string | null;
  merged_at: string | null;
  merged_by: string | null;
  priority: number;
  work_uuid: string;
  work_title: string | null;
  plan_rounds: number;
  verify_fixes: number;
  cycles: number;
  attempts: number;
  recover_attempts: number;
  pull_request_url: string | null;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  completed_at: string | null;
  completed_by: string | null;
  completion_commit: string | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One in-flight task projected onto the department pipeline (Workers tab flow
 * view). Mirrors engine FlowTask.
 */
export interface FlowTaskDTO {
  task_id: string;
  title: string;
  state: string;
  stage_index: number;
  stage_label: string;
  responsible_role: string;
  last_actor_role: string | null;
  last_activity_ts: string | null;
  last_activity_kind: string | null;
  is_stuck: boolean;
  stuck_reason: string | null;
  plan_rounds: number;
  verify_fixes: number;
  cycles: number;
  attempts: number;
}

/** The ordered department pipeline stages, shipped with the flow snapshot so the
 * frontend renders the same stepper the engine reasons about. */
export interface FlowSnapshotDTO {
  stages: string[];
  tasks: FlowTaskDTO[];
}

/** Watchdog finding DTO (maps bureau_watchdog_findings columns). */
export interface FindingDTO {
  id: string;
  task_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  finding_class: string;
  status: string;
  recovery_job_id: string | null;
  detail: string | null;
  recover_attempts: number;
  detected_at: string;
  resolved_at: string | null;
}

/** Journal entry DTO (maps bureau_journal columns). */
export interface JournalEntryDTO {
  id: number;
  ts: string;
  kind: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  task_id: string | null;
  work_uuid: string | null;
  work_title: string | null;
  job_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  detail: string;
}

/** Worker/employee roster entry (role + backing model + activity). */
export interface WorkerDTO {
  role: string;
  backend: string | null;
  model_id: string | null;
  provider: string | null;
  display: string | null;
  active: boolean;
  active_leases: number;
  running_dispatches: number;
  running_jobs: number;
  last_activity_ts: string | null;
  last_activity_kind: string | null;
}


// --- Action DTOs ---

export interface ApproveTaskRequest {
  approvedBy?: string;
}

export interface ApproveTaskResult {
  ok: boolean;
  task_id: string;
  state: string;
  approved_at: string;
  approved_by: string;
  span_id?: number;
}

export interface ArchiveTaskRequest {
  /** Why the task is being set aside (test artifact, shipped out-of-band, …). */
  reason?: string;
  archivedBy?: string;
}

export interface ArchiveTaskResult {
  ok: boolean;
  task_id: string;
  archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
}

export interface CompleteTaskRequest {
  /** The commit/hash the work shipped in (e.g. a merge commit), when known. */
  commit?: string;
  /** Free-text note about the completion. */
  note?: string;
  completedBy?: string;
}

export interface CompleteTaskResult {
  ok: boolean;
  task_id: string;
  completed: boolean;
  completed_at: string | null;
  completed_by: string | null;
  completion_commit: string | null;
  completion_note: string | null;
}

// --- Conversational Intake DTOs (task creation front door) ---

/** One turn in the intake conversation, flattened for display. */
export interface IntakeMessageDTO {
  id: string;
  /** 'human' | 'officer' | 'tool' */
  role: string;
  /** Human-readable line for the chat panel (redacted). Empty string = skip. */
  display: string;
  created_at: string;
}

/** Live snapshot of an intake session and its derived gates. */
export interface IntakeStateDTO {
  session_id: string;
  /** 'open' | 'filed' | 'abandoned' */
  state: string;
  title: string | null;
  intent: string | null;
  spec: string | null;
  acceptance: string | null;
  /** The verify command the officer drafted (never authored by the operator). */
  verify_cmd: string | null;
  verify_confirmed_at: string | null;
  verify_confirmed_by: string | null;
  model_calls: number;
  messages: IntakeMessageDTO[];
  /** Outstanding required fields: 'title' | 'intent' | 'verify_cmd' | 'verify_confirmed'. */
  gaps: string[];
  /** Latest officer question/statement awaiting the operator, if any. */
  latest_question: string | null;
  /** True when a non-vacuous verify command is drafted but not yet human-confirmed. */
  awaiting_verify_confirmation: boolean;
  /** True when confirm-and-file would succeed (all fields present, verify confirmable). */
  can_file: boolean;
  /** Set once the session has been filed into a task. */
  task_id: string | null;
}

export interface StartIntakeRequest {
  /** Plain-English description of what the operator wants. */
  prompt: string;
  /** Optional explicit title; defaults to the prompt. */
  title?: string;
  startedBy?: string;
}

export interface IntakeReplyRequest {
  /** Plain-English answer to the officer's question. */
  message: string;
}

export interface ConfirmFileResult {
  ok: boolean;
  task_id: string;
  state: string;
  title: string | null;
  created_at: string;
}

// --- Agent task-filing door (peer agents: Claude / GLM) ---

export interface FileAgentTaskRequest {
  title: string;
  intent: string;
  spec?: string;
  acceptance?: string;
  verifyCmd: string;
  projectId?: string;
  /** Journal identity only — the console token IS the auth. 'claude' | 'glm'; default 'claude'. */
  agent?: string;
  idempotencyKey?: string;
}

export interface FileAgentTaskResult {
  ok: boolean;
  task_id: string;
  state: string;
  title: string;
  created_at: string;
}

// --- Settings: Google API keys (env-only; never the DB/journal) ---

/** Masked status of configured Google keys — safe for the browser. */
export interface GoogleKeyStatusDTO {
  count: number;
  /** e.g. ["AIza…9f2c"] — never the raw key. */
  masked: string[];
}

export interface SaveGoogleKeysRequest {
  /** The operator's Google API keys, in priority order. */
  keys: string[];
}

// --- Settings: Ntfy notifications ---

/** One event that sends a push — shown in the Settings "what sends
 * notifications" list. Mirrors engine NotificationEvent. */
export interface NotificationEventDTO {
  key: string;
  label: string;
  description: string;
  /** The task state that fires it, if task-driven. */
  taskState?: string;
}

export interface NtfySettingsDTO {
  ntfy_server_url: string;
  ntfy_topic: string;
  enabled: boolean;
  /** Every event that sends a notification (drives the Settings list). The
   * server always populates this; optional so partial fixtures still type. */
  events?: NotificationEventDTO[];
}

export interface SaveNtfySettingsRequest {
  ntfy_server_url?: string;
  ntfy_topic?: string;
}

/** Result of a manual test-notification send from Settings. */
export interface TestNtfyResult {
  ok: boolean;
  /** Whether an ntfy topic is configured at all. */
  configured: boolean;
  /** Whether the test push was accepted by the ntfy server. */
  sent: boolean;
}

// --- Department Assets DTOs ---

export interface AssetDTO {
  id: string;
  name: string;
  category: string;
  url: string;
  description: string | null;
  owner: string | null;
  status: 'Active' | 'Inactive';
  created_at: string;
  updated_at: string;
}

export interface CreateAssetRequest {
  name: string;
  category?: string;
  url: string;
  description?: string;
  owner?: string;
  status?: 'Active' | 'Inactive';
}

export interface UpdateAssetRequest {
  name?: string;
  category?: string;
  url?: string;
  description?: string;
  owner?: string;
  status?: 'Active' | 'Inactive';
}

export interface DeleteAssetResult {
  ok: boolean;
  id: string;
}

// --- Projects DTOs (multi-repo: where the department's juniors do their work) ---

/** A registered project = one git repository the bureau can run tasks against. */
export interface ProjectDTO {
  id: string;
  name: string;
  /** Absolute path on disk to the project's git repository (the "folder"). */
  path_to_repo: string;
  description: string | null;
  github_url?: string | null;
  provisioned_by?: string | null;
  visibility?: string | null;
  /** Path-hazard warnings (e.g. spaces in the repo path) — advisory, never blocking. */
  warnings?: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  name: string;
  /** Folder location on disk — must exist and be a git repository. */
  pathToRepo: string;
  description?: string;
}

export interface ProvisionProjectRequest {
  name: string;
  description?: string;
  visibility?: 'private' | 'public';
}

export interface ProvisionProjectResult {
  ok: boolean;
  jobId: string;
  canonicalName: string;
  state: string;
}

export interface GithubSettingsDTO {
  authenticated: boolean;
  login: string | null;
  scopes: string[];
  projects_root: string;
  repo_prefix: string;
}


export type TriggerActionKind = 'watchdog.sweep' | 'backup.push';

export interface TriggerActionRequest {
  kind: TriggerActionKind;
  target?: string;
}

export interface TriggerActionResult {
  ok: boolean;
  job_id: string;
  kind: TriggerActionKind;
  state: string;
  created_at: string;
}

export interface ApiErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}


// --- Endpoint Manifest ---

export interface ConsoleEndpointDef {
  method: 'GET' | 'POST';
  path: string;
  auth: 'token' | 'public';
  description: string;
}

// Frozen at 33 endpoints (contract_d0_c asserts the count). Reconciliation with
// the task text: docs/plan-phase8-entry.md (Stream B) said 30 -> 32, but that
// baseline predates the agent task-filing door (POST /api/tasks/file, merged
// 67eb81f) which took the base 30 -> 31. Stream B adds exactly two — GET
// /api/settings/github and POST /api/projects/provision — so the reconciled
// freeze is 31 -> 33, not 32. The stale task number is intentionally superseded.
export const ENDPOINTS: readonly ConsoleEndpointDef[] = [
  {
    method: 'GET',
    path: '/api/health',
    auth: 'token',
    description: 'Server health check'
  },
  {
    method: 'GET',
    path: '/api/dashboard',
    auth: 'token',
    description: 'Live department health dashboard snapshot'
  },
  {
    method: 'GET',
    path: '/api/tasks',
    auth: 'token',
    description: 'List live (non-archived) task summaries'
  },
  {
    method: 'GET',
    path: '/api/tasks/archived',
    auth: 'token',
    description: 'List archived task summaries (test artifacts, set-aside work)'
  },
  {
    method: 'GET',
    path: '/api/tasks/completed',
    auth: 'token',
    description: 'List completed/shipped task summaries (tagged done, done-gate untouched)'
  },
  {
    method: 'GET',
    path: '/api/flow',
    auth: 'token',
    description: 'Department pipeline: every in-flight task, its stage, and whether it is stuck'
  },
  {
    method: 'GET',
    path: '/api/findings',
    auth: 'token',
    description: 'List active watchdog findings'
  },
  {
    method: 'GET',
    path: '/api/journal',
    auth: 'token',
    description: 'Query timeline of journal entries'
  },
  {
    method: 'GET',
    path: '/api/workers',
    auth: 'token',
    description: 'Department worker roster with active/working status'
  },
  {
    method: 'GET',
    path: '/api/assets',
    auth: 'token',
    description: 'List all department assets'
  },
  {
    method: 'POST',
    path: '/api/assets',
    auth: 'token',
    description: 'Create a new department asset'
  },
  {
    method: 'POST',
    path: '/api/assets/:id/update',
    auth: 'token',
    description: 'Update an existing department asset'
  },
  {
    method: 'POST',
    path: '/api/assets/:id/delete',
    auth: 'token',
    description: 'Delete a department asset'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/approve',
    auth: 'token',
    description: 'Approve a verified task (human-operator door)'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/archive',
    auth: 'token',
    description: 'Archive a task — set it aside without touching its state (human-operator door)'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/unarchive',
    auth: 'token',
    description: 'Restore an archived task to the live list (human-operator door)'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/complete',
    auth: 'token',
    description: 'Tag a task completed/shipped without touching its state (human-operator door)'
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/reopen',
    auth: 'token',
    description: 'Clear a task\'s completed tag and return it to the live list (human-operator door)'
  },
  {
    method: 'POST',
    path: '/api/actions/trigger',
    auth: 'token',
    description: 'Enqueue an engine job (watchdog.sweep or backup.push)'
  },
  {
    method: 'POST',
    path: '/api/intake',
    auth: 'token',
    description: 'Start a conversational intake session; officer takes its first turn'
  },
  {
    method: 'GET',
    path: '/api/intake/:id',
    auth: 'token',
    description: 'Poll an intake session: draft, conversation, and derived gates'
  },
  {
    method: 'POST',
    path: '/api/intake/:id/reply',
    auth: 'token',
    description: 'Answer the intake officer in plain English; runs the next officer turn'
  },
  {
    method: 'POST',
    path: '/api/intake/:id/confirm-file',
    auth: 'token',
    description: 'Human confirms the drafted verify command and files the task (human gate)'
  },
  {
    method: 'GET',
    path: '/api/settings/google-keys',
    auth: 'token',
    description: 'Masked status of configured Google API keys (never the raw values)'
  },
  {
    method: 'POST',
    path: '/api/settings/google-keys',
    auth: 'token',
    description: 'Save Google API keys to env + gitignored secrets file (never the DB)'
  },
  {
    method: 'GET',
    path: '/api/settings/ntfy',
    auth: 'token',
    description: 'Get configured ntfy server URL and topic'
  },
  {
    method: 'POST',
    path: '/api/settings/ntfy',
    auth: 'token',
    description: 'Save ntfy server URL and topic'
  },
  {
    method: 'POST',
    path: '/api/settings/ntfy/test',
    auth: 'token',
    description: 'Send a test push to the configured ntfy topic'
  },
  {
    method: 'GET',
    path: '/api/settings/github',
    auth: 'token',
    description: 'Masked GitHub connection status from gh auth status'
  },
  {
    method: 'GET',
    path: '/api/projects',
    auth: 'token',
    description: 'List registered projects (git repositories the bureau can work in)'
  },
  {
    method: 'POST',
    path: '/api/projects',
    auth: 'token',
    description: 'Register a project by name + folder path (validated on disk as a git repo)'
  },
  {
    method: 'POST',
    path: '/api/projects/provision',
    auth: 'token',
    description: 'Provision a new git repo + GitHub remote and register project'
  },
  {
    method: 'POST',
    path: '/api/tasks/file',
    auth: 'token',
    description: 'Agent task-filing door: auto-confirm verify + file a task under the autofile opt-in (fail-closed until enabled)'
  }
] as const;


