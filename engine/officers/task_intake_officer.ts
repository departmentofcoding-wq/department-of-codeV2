import {
  isVacuousVerify,
  taskGaps,
  type AttributionTuple,
  type BureauIntakeMessageRow,
  type BureauIntakeSessionRow,
  type DbConnection,
  type LlmClient,
  type LlmMessage,
  type LlmToolCall
} from '../contract/index.ts';
import { OFFICER_TOOLS, AskHumanSchema, ProposeFieldSchema, ProposeVerifySchema } from '../contract/tools.ts';
import { fileTask } from '../filing/file_task.ts';
import { appendIntakeMessage, getSession, incrementModelCalls, updateSessionDraft } from '../intake/session.ts';
import { callModel } from '../llm/call_model.ts';
import { TASK_INTAKE_OFFICER_SYSTEM_PROMPT } from './system_prompt.ts';

let clientOverride: LlmClient | null = null;

export function setOfficerClientOverride(client: LlmClient | null): void {
  clientOverride = client;
}

export function getOfficerClientOverride(): LlmClient | null {
  return clientOverride;
}

export interface RunOfficerTurnOptions {
  customClient?: LlmClient;
  signal?: AbortSignal;
  jobId?: string | null;
}

export interface OfficerTurnResult {
  action: 'asked' | 'filed' | 'gap_reported' | 'no_op';
  question?: string;
  taskId?: string;
  gaps?: string[];
}

export function parseMessageContent(msg: BureauIntakeMessageRow): LlmMessage | null {
  try {
    const raw = JSON.parse(msg.content);
    if (msg.role === 'human') {
      const text = typeof raw === 'string' ? raw : (raw.text ?? raw.content ?? JSON.stringify(raw));
      return { role: 'user', content: text };
    }
    if (msg.role === 'officer') {
      return {
        role: 'assistant',
        content: raw.text ?? null,
        toolCalls: raw.toolCalls ?? []
      };
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        toolCallId: raw.toolCallId ?? msg.id,
        content: typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result ?? raw)
      };
    }
  } catch {
    if (msg.role === 'human') return { role: 'user', content: msg.content };
  }
  return null;
}

export function buildLlmHistory(messages: BureauIntakeMessageRow[]): LlmMessage[] {
  const history: LlmMessage[] = [
    { role: 'system', content: TASK_INTAKE_OFFICER_SYSTEM_PROMPT }
  ];

  for (const msg of messages) {
    const parsed = parseMessageContent(msg);
    if (parsed) {
      history.push(parsed);
    }
  }

  return history;
}

export function repairOpenToolCalls(
  db: DbConnection,
  sessionId: string,
  messages: BureauIntakeMessageRow[],
  attribution: AttributionTuple
): BureauIntakeMessageRow[] {
  if (messages.length === 0) return messages;

  const lastOfficerIdx = [...messages].reverse().findIndex((m) => m.role === 'officer');
  if (lastOfficerIdx === -1) return messages;

  const actualOfficerIdx = messages.length - 1 - lastOfficerIdx;
  const officerMsg = messages[actualOfficerIdx];
  const parsedOfficer = parseMessageContent(officerMsg);

  if (parsedOfficer && parsedOfficer.role === 'assistant' && parsedOfficer.toolCalls && parsedOfficer.toolCalls.length > 0) {
    const existingToolCallIds = new Set<string>();
    for (let i = actualOfficerIdx + 1; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        try {
          const raw = JSON.parse(messages[i].content);
          if (raw.toolCallId) existingToolCallIds.add(raw.toolCallId);
        } catch {
          // ignore
        }
      }
    }

    const missingToolCalls = parsedOfficer.toolCalls.filter((tc) => !existingToolCallIds.has(tc.id));
    if (missingToolCalls.length > 0) {
      for (const tc of missingToolCalls) {
        appendIntakeMessage(db, sessionId, {
          role: 'tool',
          content: { toolCallId: tc.id, result: { status: 'repaired_after_crash', error: 'Interrupted by crash' } },
          attribution
        });
      }

      const updated = db.all<BureauIntakeMessageRow>(
        `SELECT * FROM bureau_intake_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
        sessionId
      );
      return updated;
    }
  }

  return messages;
}

export async function runOfficerTurn(
  db: DbConnection,
  sessionId: string,
  options?: RunOfficerTurnOptions
): Promise<OfficerTurnResult> {
  const officerAttr: AttributionTuple = {
    actor_role: 'task-intake-officer',
    provider: 'google',
    model: 'gemini-3.1-flash-lite',
    account: null
  };

  const activeClient = options?.customClient ?? clientOverride ?? undefined;

  let session = getSession(db, sessionId);
  if (!session) {
    throw new Error(`Intake session ${sessionId} not found`);
  }

  if (session.state === 'filed') {
    return { action: 'no_op' };
  }

  if (session.state === 'abandoned') {
    throw new Error(`Cannot run turn on abandoned session ${sessionId}`);
  }

  let messages = db.all<BureauIntakeMessageRow>(
    `SELECT * FROM bureau_intake_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
    sessionId
  );

  // 1. Repair any open tool calls left incomplete by a process crash
  messages = repairOpenToolCalls(db, sessionId, messages, officerAttr);

  // 2. Check cumulative per-session 10-call turn budget cap
  if (session.model_calls >= 10) {
    const gaps = taskGaps(session);
    if (gaps.length > 0) {
      const gapQuestion = `The turn budget limit (10 calls) has been reached. Missing required fields: ${gaps.join(', ')}. Please supply these requirements.`;
      appendIntakeMessage(db, sessionId, {
        role: 'officer',
        content: { text: gapQuestion, toolCalls: [] },
        attribution: officerAttr
      });
      return { action: 'gap_reported', question: gapQuestion, gaps };
    }
  }

  // 3. Inner turn loop: callModel -> execute tools -> append messages + update draft in 1 transaction -> repeat
  const MAX_INNER_TURNS = 10;
  for (let turnCount = 0; turnCount < MAX_INNER_TURNS; turnCount++) {
    session = getSession(db, sessionId)!;
    if (session.state === 'filed') {
      return { action: 'filed' };
    }

    if (session.model_calls >= 10) {
      const gaps = taskGaps(session);
      const gapQuestion = `Cumulative session call cap (10) reached. Outstanding gaps: ${gaps.join(', ')}`;
      return { action: 'gap_reported', question: gapQuestion, gaps };
    }

    const llmHistory = buildLlmHistory(messages);

    // Call LLM (strictly outside database transaction)
    const response = await callModel(
      db,
      'task-intake-officer',
      llmHistory,
      OFFICER_TOOLS,
      {
        customClient: activeClient,
        signal: options?.signal,
        jobId: options?.jobId
      }
    );
    const servingOfficerAttr: AttributionTuple = {
      actor_role: 'task-intake-officer',
      provider: response.provider ?? officerAttr.provider,
      model: response.model ?? officerAttr.model,
      account: null
    };

    let askHumanQuestion: string | undefined;
    let filedTaskId: string | undefined;

    // Persist model response, tool execution results, draft updates, and model_calls increment.
    // Durability across crashes is guaranteed via repairOpenToolCalls on session resume.
    incrementModelCalls(db, sessionId);

    const toolCalls = response.toolCalls ?? [];
    appendIntakeMessage(db, sessionId, {
      role: 'officer',
      content: { text: response.text ?? null, toolCalls },
      attribution: servingOfficerAttr,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      latencyMs: response.latencyMs
    });

    for (const tc of toolCalls) {
      let toolResult: Record<string, unknown>;

      if (tc.name === 'propose_field') {
        const parsed = ProposeFieldSchema.safeParse(tc.arguments);
        if (parsed.success) {
          updateSessionDraft(db, sessionId, { [parsed.data.field]: parsed.data.value });
          toolResult = { status: 'ok', field: parsed.data.field, value: parsed.data.value };
        } else {
          toolResult = { status: 'error', error: parsed.error.message };
        }
      } else if (tc.name === 'propose_verify') {
        const rawCmd = (tc.arguments as any)?.command ?? (tc.arguments as any)?.verify_cmd;
        const parsed = ProposeVerifySchema.safeParse(typeof rawCmd === 'string' ? { command: rawCmd } : tc.arguments);
        if (parsed.success) {
          if (isVacuousVerify(parsed.data.command)) {
            toolResult = {
              status: 'refused',
              reason: `Vacuous verify command refused: '${parsed.data.command}'`
            };
          } else {
            updateSessionDraft(db, sessionId, { verify_cmd: parsed.data.command });
            toolResult = { status: 'ok', command: parsed.data.command };
          }
        } else {
          toolResult = { status: 'error', error: parsed.error.message };
        }
      } else if (tc.name === 'ask_human') {
        const rawQ = (tc.arguments as any)?.question ?? (tc.arguments as any)?.text;
        const parsed = AskHumanSchema.safeParse(typeof rawQ === 'string' ? { question: rawQ } : tc.arguments);
        if (parsed.success) {
          askHumanQuestion = parsed.data.question;
          toolResult = { status: 'asked', question: parsed.data.question };
        } else {
          toolResult = { status: 'error', error: parsed.error.message };
        }
      } else if (tc.name === 'file_task') {
        try {
          const task = fileTask(db, sessionId, servingOfficerAttr);
          filedTaskId = task.id;
          toolResult = { status: 'filed', taskId: task.id };
        } catch (err: any) {
          toolResult = { status: 'error', error: err.message };
        }
      } else {
        toolResult = { status: 'error', error: `Unknown tool: ${tc.name}` };
      }

      appendIntakeMessage(db, sessionId, {
        role: 'tool',
        content: { toolCallId: tc.id, result: toolResult },
        attribution: servingOfficerAttr
      });
    }

    // Re-query messages for next loop iteration
    messages = db.all<BureauIntakeMessageRow>(
      `SELECT * FROM bureau_intake_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      sessionId
    );

    if (filedTaskId) {
      return { action: 'filed', taskId: filedTaskId };
    }

    if (askHumanQuestion) {
      return { action: 'asked', question: askHumanQuestion };
    }

    // Check deterministic taskGaps after turn execution
    session = getSession(db, sessionId)!;
    const gaps = taskGaps(session);

    // If model didn't ask human or file task, but gaps remain or no tool calls were made, check loop end
    if (response.toolCalls === undefined || response.toolCalls.length === 0) {
      if (response.text) {
        return { action: 'asked', question: response.text };
      }
      if (gaps.length > 0) {
        const gapQuestion = `Missing required task fields: ${gaps.join(', ')}. Please provide details.`;
        return { action: 'gap_reported', question: gapQuestion, gaps };
      }
      return { action: 'no_op' };
    }
  }

  session = getSession(db, sessionId)!;
  const gaps = taskGaps(session);
  return { action: 'gap_reported', gaps };
}
