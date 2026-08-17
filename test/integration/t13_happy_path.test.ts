import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple, BureauJournalRow, BureauTaskRow } from '../../engine/contract/index.ts';
import { confirmVerify, createSession, getSessionWithMessages, appendIntakeMessage } from '../../engine/intake/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { MockClient } from '../../engine/llm/mock_client.ts';
import { setOfficerClientOverride } from '../../engine/officers/task_intake_officer.ts';
import { drainSingleJob } from '../../runner/main.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t13-test-'));
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

describe.each(testImplementations)('T13: Full Happy Path on Mocks ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;

  beforeEach(() => {
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    setOfficerClientOverride(null);
    cleanup();
  });

  it('completes file -> question -> answer -> propose_verify -> confirm -> file_task', async () => {
    // 1. Initial intake request
    const session = createSession(db, {
      title: 'Fix authentication login bug',
      attribution: humanAttr
    });

    // 2. Setup mock officer responses
    const mockClient = new MockClient([
      // Turn 1: Officer proposes intent & asks human for spec
      {
        text: 'I will propose intent and ask for technical spec.',
        toolCalls: [
          { id: 'call_1', name: 'propose_field', arguments: { field: 'intent', value: 'Fix OAuth callback token validation' } },
          { id: 'call_2', name: 'ask_human', arguments: { question: 'What technical spec or changes are needed?' } }
        ],
        tokensIn: 50,
        tokensOut: 20,
        latencyMs: 15,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      },
      // Turn 2: Officer proposes verify command and asks human to confirm
      {
        text: 'I will propose the verification command.',
        toolCalls: [
          { id: 'call_3', name: 'propose_field', arguments: { field: 'spec', value: 'Update token parser in auth.ts' } },
          { id: 'call_4', name: 'propose_verify', arguments: { command: 'vitest run test/unit/auth.test.ts' } },
          { id: 'call_4_5', name: 'ask_human', arguments: { question: 'Please confirm the verification command: vitest run test/unit/auth.test.ts' } }
        ],
        tokensIn: 100,
        tokensOut: 25,
        latencyMs: 18,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      },
      // Turn 3: Officer calls file_task
      {
        text: 'Submitting task filing.',
        toolCalls: [
          { id: 'call_5', name: 'file_task', arguments: {} }
        ],
        tokensIn: 120,
        tokensOut: 15,
        latencyMs: 12,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      }
    ]);

    setOfficerClientOverride(mockClient);

    // Turn 1: Enqueue and drain via runner pipeline
    const job1 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job1.id);

    // 3. Human answers the question
    appendIntakeMessage(db, session.id, {
      role: 'human',
      content: 'Update token parser in auth.ts to handle expired tokens correctly.',
      attribution: humanAttr
    });

    // Turn 2: Enqueue and drain via runner pipeline
    const job2 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job2.id);

    // 4. Human confirms verify command
    confirmVerify(db, session.id, humanAttr);

    // Turn 3: Enqueue and drain via runner pipeline -> calls file_task
    const job3 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job3.id);

    // 5. Verify task is queued and work session minted
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE intake_session_id = ?', session.id);
    expect(task).toBeDefined();
    expect(task?.state).toBe('queued');
    expect(task?.work_uuid).toBeDefined();
    expect(task?.work_title).toBe('Fix authentication login bug');

    // 6. Verify journal tells the story in order with every span attributed
    const journalSpans = db.all<BureauJournalRow>('SELECT * FROM bureau_journal ORDER BY id ASC');
    expect(journalSpans.length).toBeGreaterThan(0);

    const filedSpan = journalSpans.find((s) => s.kind === 'task-filed');
    expect(filedSpan).toBeDefined();
    expect(filedSpan?.task_id).toBe(task?.id);
    expect(filedSpan?.work_uuid).toBe(task?.work_uuid);

    const humanSpans = journalSpans.filter((s) => s.kind === 'human');
    expect(humanSpans.length).toBeGreaterThan(0);
    expect(humanSpans.some((s) => s.actor_role === 'human-operator')).toBe(true);

    const llmSpans = journalSpans.filter((s) => s.kind === 'llm');
    expect(llmSpans.length).toBeGreaterThan(0);
    for (const span of llmSpans) {
      expect(span.actor_role).toBe('task-intake-officer');
      expect(span.tokens_in).toBeGreaterThan(0);
      expect(span.tokens_out).toBeGreaterThan(0);
    }
  });
});
