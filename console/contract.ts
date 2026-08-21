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
  created_at: string;
  updated_at: string;
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
    description: 'List all task summaries'
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
    method: 'POST',
    path: '/api/tasks/:id/approve',
    auth: 'token',
    description: 'Approve a verified task (human-operator door)'
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
  }
] as const;
