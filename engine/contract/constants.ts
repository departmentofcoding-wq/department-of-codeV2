export const STATES = [
  'intake',
  'queued',
  'claimed',
  'verifying',
  'needs-review',
  'done',
  'failed',
  'blocked'
] as const;

export type TaskState = typeof STATES[number];

export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  'intake': ['queued'],
  'queued': ['claimed'],
  'claimed': ['queued', 'verifying'],
  'verifying': ['needs-review', 'failed', 'claimed', 'blocked'],
  'failed': ['claimed'],
  'blocked': ['claimed'],
  'needs-review': ['done'],
  'done': []
};

export const ACTOR_ROLES = [
  'intake-officer',
  'task-intake-officer',
  'scheduler',
  'senior-engineer',
  'junior-engineer',
  'verifier',
  'foreman',
  'auditor',
  'secretary',
  'human-operator',
  'system'
] as const;

export type ActorRole = typeof ACTOR_ROLES[number];

export const SPAN_KINDS = [
  'llm',
  'tool',
  'guardrail',
  'transition',
  'human',
  'system',
  'task-filed'
] as const;

export type SpanKind = typeof SPAN_KINDS[number];

export const JOB_KINDS = [
  'demo.sleep',
  'demo.chain',
  'demo.fail',
  'intake.turn',
  'worktree.prepare',
  'verify.run'
] as const;

export type JobKind = typeof JOB_KINDS[number] | (string & {});

export const JOB_STATES = [
  'pending',
  'running',
  'done',
  'failed',
  'dead'
] as const;

export type JobState = typeof JOB_STATES[number];

export const INTAKE_SESSION_STATES = [
  'open',
  'filed',
  'abandoned'
] as const;

export type IntakeSessionState = typeof INTAKE_SESSION_STATES[number];

export const INTAKE_MESSAGE_ROLES = [
  'human',
  'officer',
  'tool'
] as const;

export type IntakeMessageRole = typeof INTAKE_MESSAGE_ROLES[number];

export const BUDGET_META_KEYS = {
  ROLLING_24H_TOKENS_CEILING: 'budget:rolling_24h_tokens:ceiling',
  ROLLING_24H_REQUESTS_CEILING: 'budget:rolling_24h_requests:ceiling',
  VERIFY_FIXES_CEILING: 'verify:fixes:ceiling',
  VERIFY_TIMEOUT_MS: 'verify:timeout_ms'
} as const;

export const VACUOUS_VERIFY_COMMANDS = [
  'exit 0',
  'true',
  ':',
  'echo ok',
  'echo',
  'pass'
] as const;

export const DETERMINISTIC_ATTRIBUTION = {
  provider: 'deterministic',
  model: 'core',
  account: null
} as const;
