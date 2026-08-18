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
  }
] as const;
