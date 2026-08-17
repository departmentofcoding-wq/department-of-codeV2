import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple } from '../../engine/contract/index.ts';
import { fileTask } from '../../engine/filing/file_task.ts';
import { confirmVerify, createSession, updateSessionDraft } from '../../engine/intake/index.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t11-test-'));
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

describe.each(testImplementations)('T11: Human Confirmation Requirement ($name)', ({ create }) => {
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

  it('prevents filing without human confirmation, and requires fresh confirmation when verify_cmd is re-proposed', () => {
    const session = createSession(db, { attribution: officerAttr });

    updateSessionDraft(db, session.id, {
      title: 'Confirmation Test',
      intent: 'Verify human confirmation requirement',
      verify_cmd: 'npm test'
    });

    // 1. Attempt filing without human confirmation -> MUST throw
    expect(() => {
      fileTask(db, session.id, officerAttr);
    }).toThrow(/missing required gaps: verify_confirmed/);

    // 2. Human confirms verify command
    const confirmed = confirmVerify(db, session.id, humanAttr);
    expect(confirmed.verify_confirmed_at).not.toBeNull();
    expect(confirmed.verify_confirmed_by).toBe('human-operator:operator');

    // 3. Officer re-proposes verify_cmd (even with same command string) -> MUST reset confirmation
    const reproposed = updateSessionDraft(db, session.id, { verify_cmd: 'npm test' });
    expect(reproposed.verify_confirmed_at).toBeNull();
    expect(reproposed.verify_confirmed_by).toBeNull();

    // 4. Attempt filing after re-proposal without fresh confirmation -> MUST throw
    expect(() => {
      fileTask(db, session.id, officerAttr);
    }).toThrow(/missing required gaps: verify_confirmed/);

    // 5. Fresh human confirmation
    confirmVerify(db, session.id, humanAttr);

    // 6. Filing succeeds
    const task = fileTask(db, session.id, officerAttr);
    expect(task.id).toBeDefined();
    expect(task.state).toBe('queued');
  });
});
