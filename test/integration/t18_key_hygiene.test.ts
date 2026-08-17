import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple } from '../../engine/contract/index.ts';
import { confirmVerify, createSession, updateSessionDraft, appendIntakeMessage } from '../../engine/intake/index.ts';
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
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t18-test-'));
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

describe.each(testImplementations)('T18: API Key Hygiene ($name)', ({ create }) => {
  let db: ReturnType<typeof create>['db'];
  let cleanup: () => void;
  const originalKey = process.env.GOOGLE_API_KEY;
  const fakeKeySecret = 'AIzaSySECRET_FAKE_KEY_VALUE_1234567890';

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = fakeKeySecret;
    const res = create();
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(() => {
    setOfficerClientOverride(null);
    if (originalKey !== undefined) {
      process.env.GOOGLE_API_KEY = originalKey;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
    cleanup();
  });

  it('guarantees GOOGLE_API_KEY value appears nowhere in the entire database', async () => {
    const session = createSession(db, { title: 'Key Hygiene Test', attribution: humanAttr });

    updateSessionDraft(db, session.id, {
      intent: 'Verify key hygiene across DB',
      verify_cmd: 'npm test'
    });

    confirmVerify(db, session.id, humanAttr);

    const mockClient = new MockClient([
      {
        text: 'Filing task',
        toolCalls: [{ id: 'call_hygiene_1', name: 'file_task', arguments: {} }],
        tokensIn: 50,
        tokensOut: 10,
        latencyMs: 15,
        costUsd: null,
        finishReason: 'tool_calls',
        truncated: false
      }
    ]);

    setOfficerClientOverride(mockClient);

    const job = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId: session.id } });
    await drainSingleJob(db, job.id);

    // Full database text sweep across all tables and columns
    const journalRows = db.all<{ detail: string }>('SELECT detail FROM bureau_journal');
    for (const r of journalRows) {
      expect(r.detail).not.toContain(fakeKeySecret);
    }

    const messageRows = db.all<{ content: string }>('SELECT content FROM bureau_intake_messages');
    for (const r of messageRows) {
      expect(r.content).not.toContain(fakeKeySecret);
    }

    const jobRows = db.all<{ last_error: string | null; payload: string }>('SELECT last_error, payload FROM bureau_jobs');
    for (const r of jobRows) {
      if (r.last_error) expect(r.last_error).not.toContain(fakeKeySecret);
      if (r.payload) expect(r.payload).not.toContain(fakeKeySecret);
    }

    const metaRows = db.all<{ key: string; value: string }>('SELECT key, value FROM bureau_meta');
    for (const r of metaRows) {
      expect(r.key).not.toContain(fakeKeySecret);
      expect(r.value).not.toContain(fakeKeySecret);
    }

    const sessionRows = db.all<{ title: string | null; intent: string | null }>('SELECT title, intent FROM bureau_intake_sessions');
    for (const r of sessionRows) {
      if (r.title) expect(r.title).not.toContain(fakeKeySecret);
      if (r.intent) expect(r.intent).not.toContain(fakeKeySecret);
    }
  });
});
