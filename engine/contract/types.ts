import type { ActorRole, IntakeMessageRole, IntakeSessionState, JobState, SpanKind, TaskState, VerifyStage } from './constants.ts';

export interface AttributionTuple {
  actor_role: ActorRole;
  provider: string;
  model: string;
  account: string | null;
}

export interface BureauProjectRow {
  id: string;
  name: string;
  path_to_repo: string;
  description: string | null;
  github_url: string | null;
  provisioned_by: string | null;
  visibility: 'public' | 'private' | 'internal' | string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterProjectInput {
  name: string;
  pathToRepo: string;
  description?: string | null;
  github_url?: string | null;
  provisioned_by?: string | null;
  visibility?: 'public' | 'private' | 'internal' | string | null;
  attribution: AttributionTuple;
}

export interface ProvisionProjectInput {
  name: string;
  description?: string | null;
  visibility?: 'public' | 'private' | 'internal';
  projectsRoot?: string;
  repoPrefix?: string;
  githubOwner?: string;
  attribution: AttributionTuple;
}

export interface BureauTaskRow {
  id: string;
  title: string;
  project_id: string | null;
  intent: string | null;
  spec: string | null;
  acceptance: string | null;
  /** The specific tests that PROVE acceptance — the input to verify stage
   *  'fail-to-pass' (A3). Drafted at intake, confirmed under the verify gate.
   *  Null when a task predates staged verify or names no targeted tests. */
  acceptance_tests: string | null;
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
  recover_attempts: number;
  pull_request_url: string | null;
  intake_session_id: string | null;
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
  reviewed_commit: string | null;
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
  ide_model: string | null;
  ide_account: string | null;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  status: string;
  attempts: number;
  created_at: string;
  finished_at: string | null;
}

export interface BureauIntakeSessionRow {
  id: string;
  project_id: string | null;
  state: IntakeSessionState;
  title: string | null;
  intent: string | null;
  spec: string | null;
  acceptance: string | null;
  verify_cmd: string | null;
  verify_confirmed_at: string | null;
  verify_confirmed_by: string | null;
  idempotency_key: string | null;
  model_calls: number;
  created_at: string;
  updated_at: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
}

export interface BureauIntakeMessageRow {
  id: string;
  session_id: string;
  role: IntakeMessageRole;
  content: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCompletionRequest {
  modelId: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmCompletionResponse {
  text?: string | null;
  toolCalls?: LlmToolCall[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number | null;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  truncated: boolean;
  provider?: string;
  model?: string;
}

export type LlmErrorKind = 'rate-limited' | 'auth' | 'timeout' | 'network' | 'invalid';

export class LlmError extends Error {
  public readonly kind: LlmErrorKind;
  public readonly retryAfterMs?: number;

  constructor(kind: LlmErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
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

export interface BureauWorktreeRow {
  id: string;
  task_id: string;
  path: string;
  base_commit: string;
  status: 'ready' | 'dirty' | 'stale' | 'removed';
  created_at: string;
  updated_at: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
}

export interface BureauVerifyRunRow {
  id: string;
  task_id: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  duration_ms: number;
  verify_fixes_before: number;
  stdout_tail: string | null;
  stderr_tail: string | null;
  /** JSON-encoded VerifyStageResult[] — the per-stage outcomes of a staged
   *  verify run (A3). Null for legacy single-command runs. */
  stages: string | null;
  /** Full-suite passing test count before/after the run, so the ledger can prove
   *  no regression (the pass-to-pass stage). Null when not a staged run. */
  pass_before: number | null;
  pass_after: number | null;
  started_at: string;
  finished_at: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
}

/** One stage's outcome within a staged verify run (A3). Serialized into
 *  BureauVerifyRunRow.stages. The overall run's exit code stays the contract:
 *  0 iff every non-skipped stage exited 0. */
export interface VerifyStageResult {
  stage: VerifyStage;
  exit_code: number;
  duration_ms: number;
  /** True when the stage had nothing to run (e.g. no acceptance_tests named). */
  skipped?: boolean;
  detail?: string | null;
}

export interface WorkspaceHandle {
  taskId: string;
  path: string;
  baseCommit: string;
}

export interface WorkspaceProvider {
  prepare(db: DbConnection, taskId: string): Promise<WorkspaceHandle>;
  getWorkspaceHandle(db: DbConnection, taskId: string): Promise<WorkspaceHandle>;
  checkpoint(db: DbConnection, taskId: string, attribution: AttributionTuple, note?: string): Promise<void>;
  isClean(db: DbConnection, taskId: string): Promise<boolean>;
  prune(db: DbConnection, taskId: string): Promise<void>;
}

export interface CreatePrInput {
  branch: string;
  title: string;
  body: string;
  base: string;
}

export interface CreatePrResult {
  url: string;
  number: number;
}

export interface PrProvider {
  pushBranch(branch: string, cwd?: string): Promise<void>;
  createPr(input: CreatePrInput): Promise<CreatePrResult>;
  mergePr(number: number): Promise<void>;
}

export interface BureauSelectorRow {
  id: string;
  key: string;
  css: string;
  status: 'draft' | 'calibrating' | 'calibrated' | 'failed';
  match_count: number;
  last_calibrated_at: string | null;
  attempts: number;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  created_at: string;
  updated_at: string;
}

export interface BureauWindowLeaseRow {
  id: string;
  window_target: string;
  dispatch_id: string;
  status: 'active' | 'released' | 'expired' | 'reaped';
  acquired_at: string;
  expires_at: string;
  heartbeats: number;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  created_at: string;
  updated_at: string;
}

export interface BureauObservationRow {
  id: string;
  dispatch_id: string;
  nonce: string;
  selector_key: string;
  observed: string;
  actor_role: string;
  provider: string;
  model: string;
  account: string | null;
  created_at: string;
}

export type IdeDriverAction = 'click' | 'type' | 'clear' | 'press' | 'select' | (string & {});

export interface IdeDriverLaunchOptions {
  targetWindow?: string;
  headless?: boolean;
  userDir?: string;
  port?: number;
}

export interface IdeDriverReadResult {
  matchCount: number;
  text?: string;
  attrs?: Record<string, string>;
  nonceEcho?: string;
}

export interface IdeDriverActResult {
  success: boolean;
  nonceEcho?: string;
}

export interface IdeDriverSnapshotResult {
  outline: string;
}

export interface IdeDriver {
  launch(opts?: IdeDriverLaunchOptions): Promise<void>;
  navigate(url: string): Promise<void>;
  read(selectorKey: string): Promise<IdeDriverReadResult>;
  act(selectorKey: string, action: IdeDriverAction, value?: string): Promise<IdeDriverActResult>;
  snapshot(): Promise<IdeDriverSnapshotResult>;
  close(): Promise<void>;
}

export interface BureauOwnershipRow {
  key: string;
  holder_id: string;
  holder_role: string;
  leased_at: string;
  expires_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type OwnershipRow = BureauOwnershipRow;

export interface BureauWatchdogFindingRow {
  id: string;
  task_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  finding_class: string;
  status: string;
  recovery_job_id: string | null;
  recover_attempts: number;
  detail: string | null;
  detected_at: string;
  resolved_at: string | null;
}

export type WatchdogFinding = BureauWatchdogFindingRow;

export interface BureauAssetRow {
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

export interface CreateRemoteOptions {
  name: string;
  owner: string;
  visibility: 'private' | 'public' | 'internal' | string;
  sourcePath: string;
  description?: string | null;
}

export interface CreateRemoteResult {
  url: string;
}

export interface RepoProvider {
  createRemote(opts: CreateRemoteOptions): Promise<CreateRemoteResult>;
}
