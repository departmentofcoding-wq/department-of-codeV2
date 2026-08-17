export const STATES = [
  'intake',
  'queued',
  'claimed',
  'verifying',
  'needs-review',
  'done',
  'failed'
] as const;

export type TaskState = typeof STATES[number];

export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  'intake': ['queued'],
  'queued': ['claimed'],
  'claimed': ['queued', 'verifying'],
  'verifying': ['needs-review', 'failed'],
  'failed': ['claimed'],
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
  'system'
] as const;

export type SpanKind = typeof SPAN_KINDS[number];

export const JOB_KINDS = [
  'demo.sleep',
  'demo.chain',
  'demo.fail'
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

export const DETERMINISTIC_ATTRIBUTION = {
  provider: 'deterministic',
  model: 'core',
  account: null
} as const;
