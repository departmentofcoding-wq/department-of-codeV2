import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple } from '../../engine/contract/index.ts';
import { createSession } from '../../engine/intake/index.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { buildLlmHistory, runOfficerTurn } from '../../engine/officers/task_intake_officer.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t12-test-'));
      const dbPath = path.join(tmpDir, 'test.db');
      const db = createRealSqliteDb(dbPath);
      return {
        db,
        cleanup: () => {
          db.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      };
    }
  }
];

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

describe.each(testImplementations)('T12: Tool Replay Requirement ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('replays prior tool_use and tool_result blocks on subsequent turns', async () => {
    const session = createSession(db, { title: 'Test Tool Replay', attribution: humanAttr });

    const mockClient = new MockClient([
      // Turn 1: Propose field and verify
      {
        text: 'I will propose field and verify command.',
        toolCalls: [
          { id: 'call_1', name: 'propose_field', arguments: { field: 'intent', value: 'Fix bug' } },
          { id: 'call_2', name: 'propose_verify', arguments: { command: 'npm test' } }
        ],
        tokensIn: 50,
        tokensOut: 20,
        latencyMs: 10,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      },
      // Turn 2: Ask human
      {
        text: null,
        toolCalls: [
          { id: 'call_3', name: 'ask_human', arguments: { question: 'Is this complete?' } }
        ],
        tokensIn: 80,
        tokensOut: 15,
        latencyMs: 12,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      }
    ]);

    await runOfficerTurn(db, session.id, { customClient: mockClient });

    // Assert mockClient received history with tool calls and tool results
    const lastRequest = mockClient.callHistory[mockClient.callHistory.length - 1];
    expect(lastRequest).toBeDefined();

    const assistantMsgs = lastRequest.messages.filter((m) => m.role === 'assistant');
    const toolMsgs = lastRequest.messages.filter((m) => m.role === 'tool');

    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(toolMsgs.length).toBeGreaterThan(0);

    // Verify exact toolCallId matches
    const toolCallIds = assistantMsgs.flatMap((a) => (a.role === 'assistant' ? a.toolCalls.map((tc) => tc.id) : []));
    const resultCallIds = toolMsgs.map((t) => (t.role === 'tool' ? t.toolCallId : ''));

    for (const id of toolCallIds) {
      expect(resultCallIds).toContain(id);
    }
  });

  it('buildLlmHistory includes tool_result entries matching officer tool_use calls', () => {
    const rawMessages = [
      {
        id: 'msg-1',
        session_id: 's-1',
        role: 'officer' as const,
        content: JSON.stringify({
          text: 'Proposing field',
          toolCalls: [{ id: 'tc-999', name: 'propose_field', arguments: { field: 'title', value: 'Test' } }]
        }),
        actor_role: 'task-intake-officer',
        provider: 'ollama',
        model: 'qwen2.5-coder',
        account: null,
        tokens_in: 10,
        tokens_out: 10,
        latency_ms: 10,
        created_at: new Date().toISOString()
      },
      {
        id: 'msg-2',
        session_id: 's-1',
        role: 'tool' as const,
        content: JSON.stringify({ toolCallId: 'tc-999', result: { status: 'ok' } }),
        actor_role: 'task-intake-officer',
        provider: 'ollama',
        model: 'qwen2.5-coder',
        account: null,
        tokens_in: null,
        tokens_out: null,
        latency_ms: null,
        created_at: new Date().toISOString()
      }
    ];

    const history = buildLlmHistory(rawMessages);
    const toolMsg = history.find((m) => m.role === 'tool');

    expect(toolMsg).toBeDefined();
    expect(toolMsg?.role).toBe('tool');
    if (toolMsg && toolMsg.role === 'tool') {
      expect(toolMsg.toolCallId).toBe('tc-999');
      expect(toolMsg.content).toBe(JSON.stringify({ status: 'ok' }));
    }
  });
});
