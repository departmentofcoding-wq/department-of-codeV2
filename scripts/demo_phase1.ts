import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { confirmVerify, createSession, getSessionWithMessages, updateSessionDraft, appendIntakeMessage } from '../engine/intake/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { fileTask } from '../engine/filing/file_task.ts';
import { enqueueJob } from '../engine/jobs/jobs.ts';
import { runOfficerTurn, setOfficerClientOverride } from '../engine/officers/task_intake_officer.ts';
import { MockClient } from '../engine/llm/mock_client.ts';
import { drainSingleJob } from '../runner/main.ts';
import type { AttributionTuple, BureauJournalRow, BureauTaskRow } from '../engine/contract/index.ts';

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

async function main() {
  console.log('=== DEPARTMENT OF CODE V2 — PHASE 1 EXIT DEMO ===\n');

  // Use a throwaway temporary database to avoid polluting db/bureau.db
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-demo-'));
  const dbPath = path.join(tmpDir, 'demo.db');
  const db = openDbConnection(dbPath);

  try {
    // 1. Create Session
    const session = createSession(db, {
      title: 'Phase 1 Exit Demo: User Auth Refactor',
      attribution: humanAttr
    });
    console.log(`[1] Created Intake Session ID: ${session.id}`);

    // 2. Mock Officer Turn 1: Propose Intent & Acceptance & ask question
    const mockClient = new MockClient([
      {
        text: 'I will set intent and acceptance, then ask for technical spec.',
        toolCalls: [
          { id: 'demo_1', name: 'propose_field', arguments: { field: 'intent', value: 'Refactor user auth handler for JWT security' } },
          { id: 'demo_1b', name: 'propose_field', arguments: { field: 'acceptance', value: 'All auth unit tests pass cleanly' } },
          { id: 'demo_2', name: 'ask_human', arguments: { question: 'What verification command should be used?' } }
        ],
        tokensIn: 60,
        tokensOut: 20,
        latencyMs: 12,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      },
      {
        text: 'I will set the technical spec, propose the verification command, and ask for confirmation.',
        toolCalls: [
          { id: 'demo_3a', name: 'propose_field', arguments: { field: 'spec', value: 'Update JWT verification logic in auth.ts' } },
          { id: 'demo_3', name: 'propose_verify', arguments: { command: 'vitest run test/unit/auth.test.ts' } },
          { id: 'demo_3b', name: 'ask_human', arguments: { question: 'Please confirm the verify command.' } }
        ],
        tokensIn: 90,
        tokensOut: 15,
        latencyMs: 14,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      },
      {
        text: 'Filing task now.',
        toolCalls: [
          { id: 'demo_4', name: 'file_task', arguments: {} }
        ],
        tokensIn: 110,
        tokensOut: 10,
        latencyMs: 10,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      }
    ]);

    setOfficerClientOverride(mockClient);

    // Run Turn 1
    const job1 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job1.id);
    console.log('[2] Officer completed Turn 1 (Intent set, question asked).');

    // Human answers
    appendIntakeMessage(db, session.id, {
      role: 'human',
      content: 'Use vitest run test/unit/auth.test.ts to verify.',
      attribution: humanAttr
    });

    // Run Turn 2
    const job2 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job2.id);
    console.log('[3] Officer completed Turn 2 (Verify command proposed).');

    // Human confirms verify command
    confirmVerify(db, session.id, humanAttr);
    console.log('[4] Human operator confirmed verify command.');

    // Run Turn 3
    const job3 = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job3.id);
    console.log('[5] Officer completed Turn 3 (file_task executed).');

    // Check Task
    const task = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE intake_session_id = ?', session.id);
    console.log(`\n=== FILED TASK RESULT ===`);
    console.log(`Task ID: ${task?.id}`);
    console.log(`State: ${task?.state} (Expected: queued)`);
    console.log(`Work UUID: ${task?.work_uuid}`);
    console.log(`Work Title: ${task?.work_title}`);
    console.log(`Verify Command: ${task?.verify_cmd}`);

    // --- Durability Demonstration ---
    console.log('\n=== DEMONSTRATING PROCESS KILL & RESUME DURABILITY ===');
    const dSession = createSession(db, {
      title: 'Durability Demo Session',
      attribution: humanAttr
    });
    console.log(`[6] Created Durability Intake Session ID: ${dSession.id}`);

    // Simulate mid-turn process interruption leaving an open tool call in message history
    appendIntakeMessage(db, dSession.id, {
      role: 'officer',
      content: {
        text: 'Interrupted turn',
        toolCalls: [{ id: 'd_call_1', name: 'propose_field', arguments: { field: 'intent', value: 'Draft intent' } }]
      },
      attribution: { actor_role: 'task-intake-officer', provider: 'ollama', model: 'qwen2.5-coder', account: null }
    });

    const dClient = new MockClient([
      {
        text: 'Resumed after mid-turn kill.',
        toolCalls: [{ id: 'd_call_2', name: 'ask_human', arguments: { question: 'Please confirm resume.' } }],
        tokensIn: 40,
        tokensOut: 15,
        latencyMs: 8,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      }
    ]);
    setOfficerClientOverride(dClient);

    const dJob = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: dSession.id } });
    await drainSingleJob(db, dJob.id);

    const sessionRes = getSessionWithMessages(db, dSession.id);
    console.log(`[7] Mid-turn open tool calls repaired automatically on resume:`);
    const repairedToolMsg = sessionRes.messages.find((m) => m.role === 'tool' && m.content.includes('d_call_1'));
    console.log(`    Repaired Tool Message: ${repairedToolMsg ? 'YES' : 'NO'}`);
    console.log(`    Total Session Model Calls: ${sessionRes.session.model_calls}`);

    // Journal Summary
    const journalSpans = db.all<BureauJournalRow>('SELECT * FROM bureau_journal ORDER BY id ASC');
    console.log(`\n=== JOURNAL ATTRIBUTION SUMMARY (${journalSpans.length} spans) ===`);
    for (const s of journalSpans) {
      console.log(`- [${s.kind}] actor: ${s.actor_role} (${s.provider}/${s.model}) detail: ${s.detail}`);
    }

    setOfficerClientOverride(null);
    console.log('\n=== PHASE 1 EXIT DEMO COMPLETED SUCCESSFULLY ===');
  } finally {
    setOfficerClientOverride(null);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

void main();
