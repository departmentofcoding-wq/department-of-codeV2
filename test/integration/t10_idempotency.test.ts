import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple } from '../../engine/contract/index.ts';
import { fileTask } from '../../engine/filing/file_task.ts';
import { confirmVerify, createSession, getSessionByIdempotencyKey, updateSessionDraft } from '../../engine/intake/index.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t10-test-'));
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

const officerAttr: AttributionTuple = {
  actor_role: 'task-intake-officer',
  provider: 'ollama',
  model: 'llama3',
  account: null
};

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

describe.each(testImplementations)('T10: Idempotent Filing ($name)', ({ create }) => {
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

  it('filing twice with the same idempotency key yields one task; second call returns original task', () => {
    const idempotencyKey = 'task-idempotency-key-777';

    // Session 1 created with idempotencyKey
    const session = createSession(db, {
      idempotencyKey,
      attribution: officerAttr
    });

    updateSessionDraft(db, session.id, {
      title: 'Idempotent Task',
      intent: 'Test duplicate filing calls',
      verify_cmd: 'vitest run'
    });

    confirmVerify(db, session.id, humanAttr);

    // First fileTask call
    const task1 = fileTask(db, session.id, officerAttr);
    expect(task1).toBeDefined();
    expect(task1.id).toBeDefined();

    // Re-retrieving session by idempotency key finds same session
    const existingSession = getSessionByIdempotencyKey(db, idempotencyKey);
    expect(existingSession?.id).toBe(session.id);
    expect(existingSession?.state).toBe('filed');

    // Second fileTask call on same session
    const task2 = fileTask(db, existingSession!.id, officerAttr);

    // Assert second call returns original task
    expect(task2.id).toBe(task1.id);
    expect(task2.work_uuid).toBe(task1.work_uuid);
    expect(task2.created_at).toBe(task1.created_at);

    // Assert exactly 1 task exists in bureau_tasks table
    const taskRows = db.all('SELECT * FROM bureau_tasks');
    expect(taskRows).toHaveLength(1);

    // Assert exactly 1 task-filed span in journal
    const journalSpans = db.all(`SELECT * FROM bureau_journal WHERE kind = 'task-filed'`);
    expect(journalSpans).toHaveLength(1);
  });
});
