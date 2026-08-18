import { ACTOR_ROLES, BUDGET_META_KEYS } from '../contract/constants.ts';
import { getMockClientOverride, LlmError, type ActorRole } from '../contract/index.ts';
import type { BureauAssignmentRow, BureauModelRow, DbConnection, LlmClient, LlmCompletionRequest, LlmCompletionResponse, LlmMessage, LlmToolDefinition } from '../contract/index.ts';
import { journal } from '../journal/writer.ts';
import { getAssignment, getModel, listModels } from '../models/registry.ts';
import { notifyOperator } from '../state/notifications.ts';
import { GoogleClient } from './google_client.ts';
import { OllamaClient } from './ollama_client.ts';
import { MockClient } from './mock_client.ts';

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
    if (m.provider === 'google' && !process.env.GOOGLE_API_KEY) return false;
    return true;
  });
}

export async function callModel(
  db: DbConnection,
  role: ActorRole | (string & {}),
  messages: LlmMessage[],
  tools?: LlmToolDefinition[],
  options?: CallModelOptions
): Promise<LlmCompletionResponse> {
  let candidates = getCandidateModels(db, role);
  if (candidates.length === 0 && options?.customClient && listModels(db).length === 0) {
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

  // 2. Candidate execution & rotation loop
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    let client: LlmClient;
    const mockOverride = getMockClientOverride();
    if (options?.customClient) {
      client = options.customClient;
    } else if (mockOverride) {
      client = mockOverride;
    } else if (process.env.NODE_ENV !== 'production' && process.env.BUREAU_MOCK_LLM === 'true') {
      client = new MockClient();
    } else if (candidate.provider === 'google') {
      client = new GoogleClient();
    } else if (candidate.provider === 'ollama') {
      client = new OllamaClient();
    } else {
      throw new LlmError('invalid', `Unsupported LLM provider '${candidate.provider}' for model '${candidate.id}'`);
    }

    try {
      const response = await client.complete({
        modelId: candidate.id,
        messages,
        tools,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal
      });

      // Journal llm span with dynamic actor_role derived from role parameter
      journal(db, {
        kind: 'llm',
        attribution: {
          actor_role: role as ActorRole,
          provider: candidate.provider,
          model: candidate.id,
          account: null
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
        provider: candidate.provider,
        model: candidate.id
      };
    } catch (err: any) {
      lastError = err;
      if (err instanceof LlmError && err.kind === 'rate-limited') {
        const retryMs = err.retryAfterMs ?? 60000;
        setModelCooldown(db, candidate.id, retryMs);

        // Emit guardrail span attributed to the model that refused
        journal(db, {
          kind: 'guardrail',
          attribution: {
            actor_role: role as ActorRole,
            provider: candidate.provider,
            model: candidate.id,
            account: null
          },
          taskId: options?.taskId,
          workUuid: options?.workUuid,
          jobId: options?.jobId,
          detail: { action: 'quota_exceeded_cooldown', retryAfterMs: retryMs }
        });

        // Rotate to next candidate in roster
        continue;
      }
      throw err;
    }
  }

  throw lastError || new LlmError('rate-limited', 'All candidate models failed or were rate-limited');
}
