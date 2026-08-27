import {
  AGENT_FILE_ACTOR_ROLES,
  INTAKE_META_KEYS
} from '../contract/constants.ts';
import {
  formatActor,
  isVacuousVerify
} from '../contract/validation.ts';
import type { AttributionTuple, BureauIntakeSessionRow, BureauTaskRow, DbConnection } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { createSession, getSessionByIdempotencyKey } from '../intake/session.ts';
import { fileTask } from './file_task.ts';

/** Typed refusal from the agent task-filing door (mirrors ProvisionError). */
export class AgentFileError extends Error {
  public readonly code: string;
  constructor(message: string, code: string = 'agent_file_error') {
    super(message);
    this.name = 'AgentFileError';
    this.code = code;
  }
}

export interface AgentFileTaskInput {
  title: string;
  intent: string;
  spec?: string | null;
  acceptance?: string | null;
  verifyCmd: string;
  projectId?: string | null;
  idempotencyKey?: string | null;
  attribution: AttributionTuple;
}

/**
 * Sanctioned agent identities for the filing door. Provider + model carry the
 * identity (the ACTOR_ROLES vocabulary is frozen — both peers file as
 * senior-engineer). GLM's model id is the ZCode picker label, per
 * engine/harness/senior.ts.
 */
export const AGENT_IDENTITIES = {
  claude: {
    actor_role: 'senior-engineer',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    account: null
  },
  glm: {
    actor_role: 'senior-engineer',
    provider: 'zai',
    model: 'glm-5.2',
    account: null
  }
} as const satisfies Record<string, AttributionTuple>;

export type AgentIdentityKey = keyof typeof AGENT_IDENTITIES;

/** The operator opt-in for agent autofile. Default false — the door is
 * fail-closed until this is explicitly turned on. */
export function isAgentAutofileEnabled(db: DbConnection): boolean {
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    INTAKE_META_KEYS.AGENT_AUTOFILE
  );
  return row?.value === 'true';
}

export function setAgentAutofile(db: DbConnection, on: boolean): void {
  db.run(
    'INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    INTAKE_META_KEYS.AGENT_AUTOFILE,
    on ? 'true' : 'false'
  );
}

// A refusal must journal its guardrail span even when the caller's attribution
// is missing or malformed — the span itself never becomes the failure.
const MALFORMED_ATTRIBUTION: AttributionTuple = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'core',
  account: null
};

function refusalAttribution(candidate: unknown): AttributionTuple {
  if (candidate && typeof candidate === 'object') {
    const a = candidate as Partial<AttributionTuple>;
    if (a.actor_role && a.provider && a.model) {
      return a as AttributionTuple;
    }
  }
  return MALFORMED_ATTRIBUTION;
}

function refuse(
  db: DbConnection,
  input: AgentFileTaskInput,
  code: string,
  message: string,
  detail: Record<string, unknown>
): never {
  const attribution = refusalAttribution(input?.attribution);
  journal(db, {
    kind: 'guardrail',
    attribution,
    detail: { action: 'agent_task_file_refused', code, ...detail }
  });
  throw new AgentFileError(message, code);
}

/**
 * Set the verify-confirm columns directly on the session row, attributed to the
 * AGENT. This deliberately does NOT go through engine/intake/confirm.ts —
 * confirmVerify stays human-operator-only so the human door keeps its exact
 * guarantee. The journal span records honest provenance: an agent auto-confirmed
 * under the autofile opt-in, never a forged human.
 */
function autoConfirmAgentVerify(
  db: DbConnection,
  sessionId: string,
  attribution: AttributionTuple
): void {
  const now = new Date().toISOString();
  const confirmedBy = formatActor(attribution);
  const row = db.get<{ id: string }>(`
    UPDATE bureau_intake_sessions
    SET verify_confirmed_at = ?, verify_confirmed_by = ?, updated_at = ?
    WHERE id = ? AND state = 'open'
    RETURNING id
  `, now, confirmedBy, now, sessionId);

  if (!row) {
    throw new AgentFileError(
      `Cannot auto-confirm verify for session ${sessionId} (missing or not open)`,
      'session_not_open'
    );
  }

  journal(db, {
    kind: 'system',
    attribution,
    detail: { action: 'agent-auto-confirm-verify', autofile: true, sessionId }
  });
}

/**
 * The official task-filing door for peer agents: one attributed, journaled,
 * non-conversational path to enqueue a bureau_tasks row. Thin over the existing
 * machinery — createSession + the verify-confirm columns + the UNCHANGED
 * fileTask (which inserts the task queued and enqueues plan.cycle). Every
 * refusal writes a guardrail span; refusals run OUTSIDE the filing transaction
 * so their spans survive (execTransaction rolls back on throw).
 *
 * This door only lifts the START-side human verify-confirm gate, and only when
 * the operator has opted in via the intake:agent_autofile meta key. The
 * done-gate (verifier exit 0 AND human approval before merge) stays absolute.
 */
export function fileAgentTask(db: DbConnection, input: AgentFileTaskInput): BureauTaskRow {
  // 1. Actor allowlist gate — a NEW array, not a change to the frozen ACTOR_ROLES.
  const actorRole = input?.attribution?.actor_role;
  if (!actorRole || !(AGENT_FILE_ACTOR_ROLES as readonly string[]).includes(actorRole)) {
    refuse(db, input, 'actor_not_allowed',
      `Actor role '${String(actorRole)}' is not allowed to file agent tasks. Allowed: ${AGENT_FILE_ACTOR_ROLES.join(', ')}`,
      { actor_role: actorRole ?? null, allowed: AGENT_FILE_ACTOR_ROLES });
  }

  // 2. Autonomy-flag gate — fail-closed: OFF until the operator opts in.
  if (!isAgentAutofileEnabled(db)) {
    refuse(db, input, 'autofile_disabled',
      `Agent autofile is disabled (fail-closed). The operator must opt in by setting bureau_meta '${INTAKE_META_KEYS.AGENT_AUTOFILE}' = 'true' (npm run task:file -- --enable).`,
      { metaKey: INTAKE_META_KEYS.AGENT_AUTOFILE, enabled: false });
  }

  // 3. Field validation — the one real protection the human verify gate gave:
  //    a trivial or empty verify command cannot slip in through this door.
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const intent = typeof input.intent === 'string' ? input.intent.trim() : '';
  if (!title || !intent) {
    refuse(db, input, 'missing_fields',
      `Agent task filing requires non-empty 'title' and 'intent' (got title='${title}', intent='${intent ? '<present>' : ''}').`,
      { missing: !title ? ['title', ...(!intent ? ['intent'] : [])] : ['intent'] });
  }
  if (!input.verifyCmd || isVacuousVerify(input.verifyCmd)) {
    refuse(db, input, 'vacuous_verify',
      `Agent task filing requires a real verify command; '${String(input.verifyCmd)}' is empty or vacuous.`,
      { verifyCmd: input.verifyCmd ? '<vacuous>' : null });
  }

  // 4. Idempotency — the deterministic-id pattern applied at the session
  //    layer: a retry with the same key returns the already-filed task.
  if (input.idempotencyKey) {
    const existing = getSessionByIdempotencyKey(db, input.idempotencyKey);
    if (existing) {
      const existingTask = existing.state === 'filed'
        ? db.get<BureauTaskRow>(
            'SELECT * FROM bureau_tasks WHERE intake_session_id = ?',
            existing.id
          )
        : undefined;
      if (existingTask) {
        return existingTask;
      }
      if (existing.state === 'abandoned') {
        refuse(db, input, 'session_abandoned',
          `Session ${existing.id} for idempotency key '${input.idempotencyKey}' is abandoned; cannot file.`,
          { sessionId: existing.id });
      }
      // An open session with no task yet = a retry of an interrupted call:
      // converge on ONE task by filing that session (its stored draft wins).
      return fileFromSession(db, existing, input);
    }
  }

  // 5. Create + auto-confirm + file — all in ONE transaction, so there is never
  //    a confirmed-but-unfiled or half-born agent task.
  return db.execTransaction(() => {
    const session = createSession(db, {
      title,
      intent,
      spec: input.spec?.trim() ? input.spec : null,
      acceptance: input.acceptance?.trim() ? input.acceptance : null,
      verifyCmd: input.verifyCmd,
      projectId: input.projectId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      attribution: input.attribution
    });
    return fileFromSession(db, session, input);
  });
}

function fileFromSession(
  db: DbConnection,
  session: BureauIntakeSessionRow,
  input: AgentFileTaskInput
): BureauTaskRow {
  if (session.state === 'filed') {
    const existingTask = db.get<BureauTaskRow>(
      'SELECT * FROM bureau_tasks WHERE intake_session_id = ?',
      session.id
    );
    if (existingTask) {
      return existingTask;
    }
    refuse(db, input, 'session_file_mismatch',
      `Session ${session.id} is marked filed but has no task; refusing to create a second one.`,
      { sessionId: session.id });
  }
  if (session.state !== 'open') {
    refuse(db, input, 'session_not_open',
      `Cannot file agent task from session ${session.id} in state '${session.state}'.`,
      { sessionId: session.id, state: session.state });
  }
  const file = (): BureauTaskRow => {
    autoConfirmAgentVerify(db, session.id, input.attribution);
    return fileTask(db, session.id, input.attribution);
  };
  // A fresh session arrives inside the caller's transaction (the nested
  // execTransaction runs inline); a retried open session gets its own — either
  // way confirm + file are atomic.
  return db.execTransaction(file);
}
