import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttributionTuple } from '../../engine/contract/index.ts';
import {
  appendIntakeMessage,
  confirmVerify,
  createSession,
  getOpenSessions,
  getSession,
  getSessionByIdempotencyKey,
  getSessionsAwaitingConfirmation,
  getSessionWithMessages,
  incrementModelCalls,
  updateSessionDraft
} from '../../engine/intake/index.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-session-test-'));
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
  account: 'adith'
};

describe.each(testImplementations)('Intake Session Store & Desk Queries ($name)', ({ create }) => {
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

  it('creates and retrieves sessions by id and idempotency_key', () => {
    const session = createSession(db, {
      idempotencyKey: 'key-101',
      title: 'Initial Title',
      attribution: officerAttr
    });

    expect(session.id).toBeDefined();
    expect(session.state).toBe('open');
    expect(session.title).toBe('Initial Title');
    expect(session.model_calls).toBe(0);

    const fetchedById = getSession(db, session.id);
    expect(fetchedById).toEqual(session);

    const fetchedByKey = getSessionByIdempotencyKey(db, 'key-101');
    expect(fetchedByKey).toEqual(session);
  });

  it('handles duplicate idempotency_key gracefully with a catchable error', () => {
    createSession(db, { idempotencyKey: 'dup-key', attribution: officerAttr });

    expect(() => {
      createSession(db, { idempotencyKey: 'dup-key', attribution: officerAttr });
    }).toThrow(/Session already exists with idempotency key/);
  });

  it('appends intake messages with zero-padded sequence numbers guaranteeing insertion order', () => {
    const session = createSession(db, { attribution: officerAttr });

    const msg1 = appendIntakeMessage(db, session.id, {
      role: 'human',
      content: { text: 'Hello' },
      attribution: humanAttr
    });

    const msg2 = appendIntakeMessage(db, session.id, {
      role: 'officer',
      content: { text: 'Hi, what bug?' },
      attribution: officerAttr
    });

    const msg3 = appendIntakeMessage(db, session.id, {
      role: 'human',
      content: { text: 'Login issue' },
      attribution: humanAttr
    });

    expect(msg1.id).toMatch(/msg-\d+-000001/);
    expect(msg2.id).toMatch(/msg-\d+-000002/);
    expect(msg3.id).toMatch(/msg-\d+-000003/);

    const history = getSessionWithMessages(db, session.id);
    expect(history).not.toBeNull();
    expect(history!.messages).toHaveLength(3);
    expect(history!.messages[0].id).toBe(msg1.id);
    expect(history!.messages[1].id).toBe(msg2.id);
    expect(history!.messages[2].id).toBe(msg3.id);
  });

  it('strict draft reset semantics: verify_cmd presence resets confirmation regardless of string equality', () => {
    const session = createSession(db, { attribution: officerAttr });

    // Update draft with valid verify_cmd
    updateSessionDraft(db, session.id, {
      title: 'Fix Auth',
      intent: 'Fix login bug',
      verify_cmd: 'npm test'
    });

    // Confirm verify command as human
    const confirmed = confirmVerify(db, session.id, humanAttr);
    expect(confirmed.verify_confirmed_at).not.toBeNull();
    expect(confirmed.verify_confirmed_by).toBe('human-operator:adith');

    // Branch 1: Title-only update does NOT reset confirmation
    const titleUpdated = updateSessionDraft(db, session.id, { title: 'Fix Auth V2' });
    expect(titleUpdated.verify_confirmed_at).toBe(confirmed.verify_confirmed_at);
    expect(titleUpdated.verify_confirmed_by).toBe('human-operator:adith');

    // Branch 2: Re-proposing IDENTICAL verify_cmd resets confirmation
    const identicalRepropose = updateSessionDraft(db, session.id, { verify_cmd: 'npm test' });
    expect(identicalRepropose.verify_confirmed_at).toBeNull();
    expect(identicalRepropose.verify_confirmed_by).toBeNull();

    // Re-confirm
    confirmVerify(db, session.id, humanAttr);

    // Branch 3: Different verify_cmd resets confirmation
    const differentRepropose = updateSessionDraft(db, session.id, { verify_cmd: 'vitest run' });
    expect(differentRepropose.verify_confirmed_at).toBeNull();
    expect(differentRepropose.verify_confirmed_by).toBeNull();
  });

  it('confirmVerify role gate: refuses non-human-operator roles and journals human span', () => {
    const session = createSession(db, { attribution: officerAttr });
    updateSessionDraft(db, session.id, { verify_cmd: 'npm test' });

    // Non-human role throws
    expect(() => {
      confirmVerify(db, session.id, officerAttr);
    }).toThrow(/Only human-operator can confirm verify command/);

    // Human operator succeeds
    const confirmed = confirmVerify(db, session.id, humanAttr);
    expect(confirmed.verify_confirmed_at).toBeDefined();
    expect(confirmed.verify_confirmed_by).toBe('human-operator:adith');

    // Check journal span
    const journalRows = db.all<{ kind: string; actor_role: string; detail: string }>(
      `SELECT * FROM bureau_journal WHERE kind = 'human'`
    );
    expect(journalRows.length).toBeGreaterThanOrEqual(1);
    const span = journalRows[journalRows.length - 1];
    expect(span.actor_role).toBe('human-operator');
    expect(JSON.parse(span.detail)).toEqual({
      action: 'confirm-verify',
      sessionId: session.id
    });
  });

  it('enforces session state guards: mutations fail on non-open sessions', () => {
    const session = createSession(db, { attribution: officerAttr });

    // Mark session as filed manually
    db.run(`UPDATE bureau_intake_sessions SET state = 'filed' WHERE id = ?`, session.id);

    expect(() => {
      appendIntakeMessage(db, session.id, { role: 'human', content: 'test', attribution: humanAttr });
    }).toThrow(/state filed/);

    expect(() => {
      updateSessionDraft(db, session.id, { title: 'New Title' });
    }).toThrow(/state filed/);

    expect(() => {
      confirmVerify(db, session.id, humanAttr);
    }).toThrow(/state filed/);

    expect(() => {
      incrementModelCalls(db, session.id);
    }).toThrow(/state filed/);
  });

  it('desk queries return open sessions and filter vacuous commands in TypeScript', () => {
    // Session 1: open, awaiting confirmation with real verify command
    const s1 = createSession(db, { title: 'Task 1', attribution: officerAttr });
    updateSessionDraft(db, s1.id, { verify_cmd: 'npm test' });

    // Session 2: open, vacuous verify command
    const s2 = createSession(db, { title: 'Task 2', attribution: officerAttr });
    updateSessionDraft(db, s2.id, { verify_cmd: 'exit 0' });

    // Session 3: open, confirmed verify command
    const s3 = createSession(db, { title: 'Task 3', attribution: officerAttr });
    updateSessionDraft(db, s3.id, { verify_cmd: 'vitest' });
    confirmVerify(db, s3.id, humanAttr);

    const openSessions = getOpenSessions(db);
    expect(openSessions).toHaveLength(3);

    const awaiting = getSessionsAwaitingConfirmation(db);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].id).toBe(s1.id);
  });

  it('incrementModelCalls updates model_calls count', () => {
    const session = createSession(db, { attribution: officerAttr });
    expect(session.model_calls).toBe(0);

    const inc1 = incrementModelCalls(db, session.id);
    expect(inc1.model_calls).toBe(1);

    const inc2 = incrementModelCalls(db, session.id);
    expect(inc2.model_calls).toBe(2);
  });
});
