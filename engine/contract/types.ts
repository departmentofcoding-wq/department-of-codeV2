import type { ActorRole, JobState, SpanKind, TaskState } from './constants.ts';

export interface AttributionTuple {
  actor_role: ActorRole;
  provider: string;
  model: string;
  account: string | null;
}

export interface BureauTaskRow {
  id: string;
  title: string;
  intent: string | null;
  spec: string | null;
  acceptance: string | null;
  verify_cmd: string | null;
  setup_cmd: string | null;
  state: TaskState;
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
  pull_request_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface BureauJobRow {
  id: string;
  kind: string;
  task_id: string | null;
  payload: string;
  state: JobState;
  run_after: string | null;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  reaped_count: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BureauJournalRow {
  id: number;
  ts: string;
  kind: SpanKind;
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

export interface BureauModelRow {
  id: string;
  provider: string;
  display: string;
  price_in_usd_per_mtok: number | null;
  price_out_usd_per_mtok: number | null;
  enabled: number;
  notes: string | null;
}

export interface BureauAssignmentRow {
  role: string;
  backend: string;
  model_id: string | null;
  updated_at: string;
}

export interface BureauMetaRow {
  key: string;
  value: string;
}

export interface BureauPlanRow {
  id: string;
  task_id: string;
  work_uuid: string;
  round: number;
  status: string;
  plan_text: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  created_at: string;
  updated_at: string;
}

export interface BureauPlanReviewRow {
  id: string;
  plan_id: string;
  task_id: string;
  verdict: string;
  feedback: string | null;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  created_at: string;
}

export interface BureauWorkReviewRow {
  id: string;
  task_id: string;
  work_uuid: string;
  phase: string;
  round: number;
  verdict: string;
  comments: string | null;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  created_at: string;
}

export interface BureauDispatchRow {
  id: string;
  task_id: string;
  work_uuid: string;
  job_id: string | null;
  // Nullable: a dispatch must not fail because a label in the IDE moved, and
  // "we could not tell which model did the work" is an honest value.
  ide_model: string | null;
  ide_account: string | null;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  status: string;
  created_at: string;
  finished_at: string | null;
}

export interface TimelineQueryFilters {
  taskId?: string;
  workUuid?: string;
  kind?: SpanKind;
  actorRole?: string;
  limit?: number;
  offset?: number;
}

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(...params: unknown[]): T | undefined;
  all<T>(...params: unknown[]): T[];
}

export interface DbConnection {
  prepare(sql: string): Statement;
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  exec(sql: string): void;
  execTransaction<T>(fn: () => T): T;
}

export interface JobContext {
  db: DbConnection;
  job: BureauJobRow;
  payload: any;
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface JobDefinition {
  kind: string;
  schema: any;
  handler: JobHandler;
  options: {
    maxAttempts: number;
    timeoutMs: number;
  };
}
