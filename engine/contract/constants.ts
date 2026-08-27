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
  'project-registered',
  'project-provisioned',
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
  'secretary.release',
  'project.provision'
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
  VERIFY_TIMEOUT_MS: 'verify:timeout_ms',
  // Optional department-wide structural stage command (A3 staged verify), e.g.
  // 'npm run build'. Unset → the structural stage is skipped. Kept a meta key
  // (not hardcoded) so the kernel never assumes a language/toolchain.
  VERIFY_STRUCTURAL_CMD: 'verify:structural_cmd'
} as const;

export const HARNESS_META_KEYS = {
  LEASE_MS: 'harness:lease_ms',
  LEASE_HEARTBEATS_CEILING: 'harness:lease:heartbeats'
} as const;

export const REVIEW_PR_META_KEYS = {
  REVIEW_PLAN_ROUNDS_CEILING: 'review:plan_rounds_ceiling',
  REVIEW_WORK_ROUNDS_CEILING: 'review:work_rounds_ceiling',
  PR_BASE_BRANCH: 'pr:base_branch'
} as const;

export const PROJECT_META_KEYS = {
  PROJECTS_ROOT: 'projects_root',
  REPO_PREFIX: 'repo_prefix',
  GITHUB_OWNER: 'github_owner'
} as const;

export const PROVISION_ACTOR_ROLES = [
  'junior-engineer',
  'senior-engineer',
  'human-operator'
] as const;

export type ProvisionActorRole = typeof PROVISION_ACTOR_ROLES[number];

// The agent task-filing door (engine/filing/agent_file.ts). A NEW allowlist
// array, sibling to PROVISION_ACTOR_ROLES — the ACTOR_ROLES vocabulary above
// stays frozen. Peer agents file as senior-engineer (identity carried by
// provider+model); the human door remains allowed so the operator can use the
// same machinery without the conversational intake.
export const AGENT_FILE_ACTOR_ROLES = [
  'senior-engineer',
  'human-operator'
] as const;

export type AgentFileActorRole = typeof AGENT_FILE_ACTOR_ROLES[number];

// Intake meta keys (bureau_meta k/v — no schema migration). The agent-autofile
// opt-in is OFF by default: fileAgentTask refuses (fail-closed) until the
// operator sets it. It only lifts the START-side human verify-confirm gate for
// agent-filed tasks; the done-gate (verifier exit 0 + human approval) is
// absolute and untouched.
export const INTAKE_META_KEYS = {
  AGENT_AUTOFILE: 'intake:agent_autofile'
} as const;

// Raised 3 → 7: real plans often need several revise rounds to converge, and the
// department would rather keep iterating than stall. At the ceiling the flow no
// longer blocks — it proceeds to implementation with the outstanding feedback and
// gates on the walkthrough review (see engine/flow/plan_review_cycle.ts).
export const DEFAULT_PLAN_ROUNDS_CEILING = 7;

// The senior reviews the junior's walkthrough; on REVISE the junior implements the
// fixes and the senior re-reviews, looping until APPROVE. Bounded to 5 rounds so a
// senior that never approves surfaces to the operator instead of looping forever.
export const DEFAULT_WORK_ROUNDS_CEILING = 5;

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

// Multi-tier verification (A3 — docs/plan-bureau-kernel-roadmap.md). The single
// `verify.run` command becomes a staged pipeline inside the existing job; these
// are the frozen, ORDERED stage kinds. The kernel contract is unchanged — verify
// stays deterministic, bureau-owned, exit-code 0 — only the command gets smarter.
// Stage 3 (mutation spot-check on the diff's own guards) is deliberately deferred.
export const VERIFY_STAGES = [
  'structural',   // tsc --noEmit + linter on changed files (the greenwashed-build scar)
  'fail-to-pass', // the tests named by the task's acceptance criteria (task.acceptance_tests)
  'pass-to-pass'  // the full suite; the run records pass_before/pass_after (no regression)
] as const;

export type VerifyStage = typeof VERIFY_STAGES[number];

export const DETERMINISTIC_ATTRIBUTION = {
  provider: 'deterministic',
  model: 'core',
  account: null
} as const;

export const VERIFIER_ATTRIBUTION = {
  actor_role: 'verifier',
  ...DETERMINISTIC_ATTRIBUTION
} as const;

export const WATCHDOG_ATTRIBUTION = {
  actor_role: 'system',
  ...DETERMINISTIC_ATTRIBUTION
} as const;

