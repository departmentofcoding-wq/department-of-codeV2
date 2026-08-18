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
  'claimed': ['queued', 'verifying', 'blocked'],
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
  'task-filed',
  'dispatch',
  'observation',
  'review'
] as const;

export type SpanKind = typeof SPAN_KINDS[number];

export const JOB_KINDS = [
  'demo.sleep',
  'demo.chain',
  'demo.fail',
  'intake.turn',
  'worktree.prepare',
  'verify.run',
  'junior.dispatch',
  'selector.calibrate',
  'lease.reap',
  'senior.review-plan',
  'senior.review-work',
  'pr.create',
  'pr.merge',
  'watchdog.sweep',
  'watchdog.recover',
  'backup.push',
  'secretary.claim',
  'secretary.release'
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

export const HARNESS_META_KEYS = {
  LEASE_MS: 'harness:lease_ms',
  LEASE_HEARTBEATS_CEILING: 'harness:lease:heartbeats'
} as const;

export const REVIEW_PR_META_KEYS = {
  REVIEW_PLAN_ROUNDS_CEILING: 'review:plan_rounds_ceiling',
  PR_BASE_BRANCH: 'pr:base_branch'
} as const;

export const DEFAULT_PLAN_ROUNDS_CEILING = 3;
export const DEFAULT_PR_BASE_BRANCH = 'main';

export const DEFAULT_LEASE_MS = 120_000;

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

export const VERIFIER_ATTRIBUTION = {
  actor_role: 'verifier',
  ...DETERMINISTIC_ATTRIBUTION
} as const;

