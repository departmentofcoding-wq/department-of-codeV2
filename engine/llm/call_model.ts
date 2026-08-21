import { ACTOR_ROLES, BUDGET_META_KEYS } from '../contract/constants.ts';
import { getMockClientOverride, LlmError, type ActorRole } from '../contract/index.ts';
import type { BureauAssignmentRow, BureauModelRow, DbConnection, LlmClient, LlmCompletionRequest, LlmCompletionResponse, LlmMessage, LlmToolDefinition } from '../contract/index.ts';
import { journal } from '../journal/writer.ts';
import { getAssignment, getModel, listModels } from '../models/registry.ts';
import { notifyOperator } from '../state/notifications.ts';
import { GoogleClient } from './google_client.ts';
import { OllamaClient } from './ollama_client.ts';
import { MockClient } from './mock_client.ts';
import { getGoogleKeys } from './google_keys.ts';
import { googleLimitFor } from './google_limits.ts';

export interface CallModelOptions {
  taskId?: string | null;
  workUuid?: string | null;
  jobId?: string | null;
  customClient?: LlmClient;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function getRolling24hUsage(db: DbConnection): { tokens: number; requests: number } {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = db.get<{ tokens: number | null; requests: number }>(
    `SELECT
       SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) as tokens,
       COUNT(*) as requests
     FROM bureau_journal
     WHERE kind = 'llm' AND ts >= ?`,
    since
  );

  return {
    tokens: Number(row?.tokens ?? 0),
    requests: Number(row?.requests ?? 0)
  };
}

export function isModelInCooldown(db: DbConnection, modelId: string): boolean {
  const row = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', `cooldown:${modelId}`);
  if (!row || !row.value) return false;
  return new Date(row.value).getTime() > Date.now();
}

export function setModelCooldown(db: DbConnection, modelId: string, retryAfterMs: number): void {
  const expiry = new Date(Date.now() + retryAfterMs).toISOString();
  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    `cooldown:${modelId}`,
    expiry
  );
}

export function getCandidateModels(db: DbConnection, role: string): BureauModelRow[] {
  const assignment = getAssignment(db, role);
  const allModels = listModels(db);
  const candidates: BureauModelRow[] = [];

  if (assignment && assignment.model_id) {
    const primary = getModel(db, assignment.model_id);
    if (primary && ['ollama', 'google'].includes(primary.provider)) {
      candidates.push(primary);
    }
  }

  for (const m of allModels) {
    if (['ollama', 'google'].includes(m.provider) && !candidates.some((c) => c.id === m.id)) {
      candidates.push(m);
    }
  }

  return candidates.filter((m) => {
    if (m.enabled !== 1) return false;
    if (isModelInCooldown(db, m.id)) return false;
    if (m.provider === 'google' && getGoogleKeys().length === 0) return false;
    return true;
  });
}

/** Serving account label for a Google key slot — never the key itself (T18). */
export function googleKeyAccount(keyIndex: number): string {
  return `gkey-${keyIndex}`;
}

/** Rolling per-(model,key) usage read from the append-only journal. */
export function googlePairUsage(
  db: DbConnection,
  modelId: string,
  keyIndex: number
): { rpm: number; rpd: number; tpm: number } {
  const account = googleKeyAccount(keyIndex);
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since60s = new Date(now - 60 * 1000).toISOString();

  const day = db.get<{ c: number }>(
    `SELECT COUNT(*) as c FROM bureau_journal WHERE kind = 'llm' AND model = ? AND account = ? AND ts >= ?`,
    modelId, account, since24h
  );
  const minute = db.get<{ c: number; t: number | null }>(
    `SELECT COUNT(*) as c, COALESCE(SUM(tokens_in), 0) as t
       FROM bureau_journal WHERE kind = 'llm' AND model = ? AND account = ? AND ts >= ?`,
    modelId, account, since60s
  );

  return { rpd: Number(day?.c ?? 0), rpm: Number(minute?.c ?? 0), tpm: Number(minute?.t ?? 0) };
}

export interface GoogleKeyPair {
  keyIndex: number;
  key: string;
  rpdRemaining: number;
  rpmRemaining: number;
}

/**
 * Key slots for a Google model that are under every rate cap (RPM/RPD/TPM) and
 * not in per-pair cooldown, ordered by most remaining daily headroom first.
 * This is the proactive steering: normal traffic rides the roomiest pool.
 */
export function eligibleGoogleKeyPairs(db: DbConnection, modelId: string, keys: string[]): GoogleKeyPair[] {
  const limit = googleLimitFor(modelId);
  const pairs: GoogleKeyPair[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (isModelInCooldown(db, `${modelId}:${i}`)) continue;
    const u = googlePairUsage(db, modelId, i);
    if (u.rpd >= limit.rpd || u.rpm >= limit.rpm || u.tpm >= limit.tpm) continue;
    pairs.push({ keyIndex: i, key: keys[i], rpdRemaining: limit.rpd - u.rpd, rpmRemaining: limit.rpm - u.rpm });
  }
  pairs.sort((a, b) => b.rpdRemaining - a.rpdRemaining || b.rpmRemaining - a.rpmRemaining);
  return pairs;
}

/** One concrete thing to try: a model, and (for Google) a specific key slot. */
interface CallAttempt {
  model: BureauModelRow;
  keyIndex: number | null;
  key?: string;
}

/**
 * Order candidates so the role's assigned primary is tried first, then the
 * remaining Google models by daily-quota generosity (flash-lites' 500/day
 * before the flash models' 20/day), with non-Google providers (e.g. Ollama)
 * last. Keeps officer/junior traffic on the roomy lite pools by construction.
 */
function orderCandidates(candidates: BureauModelRow[]): BureauModelRow[] {
  if (candidates.length <= 1) return candidates;
  const [primary, ...rest] = candidates;
  rest.sort((a, b) => {
    const ra = a.provider === 'google' ? googleLimitFor(a.id).rpd : -1;
    const rb = b.provider === 'google' ? googleLimitFor(b.id).rpd : -1;
    return rb - ra;
  });
  return [primary, ...rest];
}

/** Flatten ordered candidates into concrete (model × eligible-key) attempts. */
function buildAttempts(db: DbConnection, candidates: BureauModelRow[], googleKeys: string[]): CallAttempt[] {
  const attempts: CallAttempt[] = [];
  for (const model of orderCandidates(candidates)) {
    if (model.provider === 'google') {
      for (const pair of eligibleGoogleKeyPairs(db, model.id, googleKeys)) {
        attempts.push({ model, keyIndex: pair.keyIndex, key: pair.key });
      }
    } else {
      attempts.push({ model, keyIndex: null });
    }
  }
  return attempts;
}

export async function callModel(
  db: DbConnection,
  role: ActorRole | (string & {}),
  messages: LlmMessage[],
  tools?: LlmToolDefinition[],
  options?: CallModelOptions
): Promise<LlmCompletionResponse> {
  let candidates = getCandidateModels(db, role);
  if (candidates.length === 0 && (options?.customClient || getMockClientOverride()) && listModels(db).length === 0) {
    candidates = [{
      id: 'mock-model',
      provider: 'mock',
      display: 'Mock Model',
      price_in_usd_per_mtok: null,
      price_out_usd_per_mtok: null,
      enabled: 1,
      notes: null
    }];
  }

  // 1. Budget check ONCE per callModel invocation BEFORE any LLM call
  const usage = getRolling24hUsage(db);
  const tokenCeilingRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    BUDGET_META_KEYS.ROLLING_24H_TOKENS_CEILING
  );
  const reqCeilingRow = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    BUDGET_META_KEYS.ROLLING_24H_REQUESTS_CEILING
  );

  const tokenCeiling = tokenCeilingRow ? parseInt(tokenCeilingRow.value, 10) : null;
  const reqCeiling = reqCeilingRow ? parseInt(reqCeilingRow.value, 10) : null;

  const assigned = getAssignment(db, role);
  const assignedModel = assigned?.model_id ? getModel(db, assigned.model_id) : null;
  const primaryModel = candidates[0] || assignedModel || {
    id: 'unknown',
    provider: 'unknown'
  };

  const overTokenBudget = tokenCeiling !== null && !isNaN(tokenCeiling) && usage.tokens >= tokenCeiling;
  const overReqBudget = reqCeiling !== null && !isNaN(reqCeiling) && usage.requests >= reqCeiling;

  if (overTokenBudget || overReqBudget) {
    const reason = overTokenBudget
      ? `Rolling 24h token ceiling exceeded (${usage.tokens} >= ${tokenCeiling})`
      : `Rolling 24h request ceiling exceeded (${usage.requests} >= ${reqCeiling})`;

    journal(db, {
      kind: 'guardrail',
      attribution: {
        actor_role: role as ActorRole,
        provider: primaryModel.provider,
        model: primaryModel.id,
        account: null
      },
      taskId: options?.taskId,
      workUuid: options?.workUuid,
      jobId: options?.jobId,
      detail: { action: 'budget_exceeded', reason }
    });

    notifyOperator(options?.jobId || 'call_model', reason);
    throw new Error(reason);
  }

  if (candidates.length === 0) {
    throw new LlmError('rate-limited', 'No enabled, non-cooldown model available for role');
  }

  // 2. Build concrete attempts (model × key slot), proactively steered.
  const googleKeys = getGoogleKeys();
  const attempts = buildAttempts(db, candidates, googleKeys);
  if (attempts.length === 0) {
    throw new LlmError('rate-limited', 'All model/key pairs are exhausted or in cooldown for this role');
  }

  // 3. Execution & rotation loop over attempts.
  const mockOverride = getMockClientOverride();
  let lastError: Error | null = null;
  for (const attempt of attempts) {
    const { model, keyIndex } = attempt;
    const servingAccount = keyIndex !== null ? googleKeyAccount(keyIndex) : null;

    let client: LlmClient;
    if (options?.customClient) {
      client = options.customClient;
    } else if (mockOverride) {
      client = mockOverride;
    } else if (process.env.NODE_ENV !== 'production' && process.env.BUREAU_MOCK_LLM === 'true') {
      client = new MockClient();
    } else if (model.provider === 'google') {
      client = new GoogleClient(undefined, attempt.key);
    } else if (model.provider === 'ollama') {
      client = new OllamaClient();
    } else if (model.provider === 'mock') {
      client = new MockClient();
    } else {
      throw new LlmError('invalid', `Unsupported LLM provider '${model.provider}' for model '${model.id}'`);
    }

    try {
      const response = await client.complete({
        modelId: model.id,
        messages,
        tools,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal
      });

      // Journal the llm span attributed to the model AND the serving key slot.
      journal(db, {
        kind: 'llm',
        attribution: {
          actor_role: role as ActorRole,
          provider: model.provider,
          model: model.id,
          account: servingAccount
        },
        taskId: options?.taskId,
        workUuid: options?.workUuid,
        jobId: options?.jobId,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        latencyMs: response.latencyMs,
        costUsd: response.costUsd ?? null
      });

      return {
        ...response,
        provider: model.provider,
        model: model.id
      };
    } catch (err: any) {
      lastError = err;
      if (err instanceof LlmError && err.kind === 'rate-limited') {
        const retryMs = err.retryAfterMs ?? 60000;
        // Cool the specific (model,key) pair, not the whole model.
        const cooldownId = keyIndex !== null ? `${model.id}:${keyIndex}` : model.id;
        setModelCooldown(db, cooldownId, retryMs);

        journal(db, {
          kind: 'guardrail',
          attribution: {
            actor_role: role as ActorRole,
            provider: model.provider,
            model: model.id,
            account: servingAccount
          },
          taskId: options?.taskId,
          workUuid: options?.workUuid,
          jobId: options?.jobId,
          detail: { action: 'quota_exceeded_cooldown', retryAfterMs: retryMs }
        });

        // Rotate to the next pair (another key for this model, or the next model).
        continue;
      }
      throw err;
    }
  }

  throw lastError || new LlmError('rate-limited', 'All candidate models failed or were rate-limited');
}
