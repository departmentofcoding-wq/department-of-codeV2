import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VACUOUS_VERIFY_COMMANDS, type AttributionTuple } from '../../engine/contract/index.ts';
import { fileTask } from '../../engine/filing/file_task.ts';
import { confirmVerify, createSession, updateSessionDraft } from '../../engine/intake/index.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t9-test-'));
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

describe.each(testImplementations)('T9: Filing Door Vacuous Command Refusal ($name)', ({ create }) => {
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

  it('refuses every vacuous command in VACUOUS_VERIFY_COMMANDS', () => {
    for (const cmd of VACUOUS_VERIFY_COMMANDS) {
      const session = createSession(db, { attribution: officerAttr });

      updateSessionDraft(db, session.id, {
        title: `Test Vacuous: ${cmd}`,
        intent: 'Testing filing door refusal',
        verify_cmd: cmd
      });

      // Even if human attempts to confirm a vacuous command, confirmVerify refuses
      expect(() => {
        confirmVerify(db, session.id, humanAttr);
      }).toThrow(/vacuous/);

      // And fileTask refuses
      expect(() => {
        fileTask(db, session.id, officerAttr);
      }).toThrow(/missing required gaps: verify_cmd/);
    }
  });

  it('accepts legitimate verify commands when confirmed', () => {
    const session = createSession(db, { attribution: officerAttr });

    updateSessionDraft(db, session.id, {
      title: 'Valid Task',
      intent: 'Testing legitimate verify command',
      verify_cmd: 'npm test -- --filter=auth'
    });

    confirmVerify(db, session.id, humanAttr);

    const task = fileTask(db, session.id, officerAttr);
    expect(task.id).toBeDefined();
    expect(task.verify_cmd).toBe('npm test -- --filter=auth');
  });
});
