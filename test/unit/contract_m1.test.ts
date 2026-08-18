import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AskHumanSchema,
  FileTaskSchema,
  isVacuousVerify,
  normalizeCommand,
  ProposeFieldSchema,
  ProposeVerifySchema,
  taskGaps,
  VACUOUS_VERIFY_COMMANDS
} from '../../engine/contract/index.ts';
import { createFakeDb, createRealSqliteDb } from '../fixtures/db_factory.ts';

describe('Milestone M1 Contract & Validation', () => {
  it('normalizes commands by trimming, lowercasing, and collapsing whitespace', () => {
    expect(normalizeCommand('  ECHO    OK ')).toBe('echo ok');
    expect(normalizeCommand('  EXIT   0\t')).toBe('exit 0');
  });

  it('isVacuousVerify correctly identifies vacuous commands and accepts legitimate commands', () => {
    expect(isVacuousVerify(null)).toBe(true);
    expect(isVacuousVerify('')).toBe(true);
    expect(isVacuousVerify('   ')).toBe(true);
    expect(isVacuousVerify('exit 0')).toBe(true);
    expect(isVacuousVerify('  EXIT   0 ')).toBe(true);
    expect(isVacuousVerify('true')).toBe(true);
    expect(isVacuousVerify(' : ')).toBe(true);
    expect(isVacuousVerify('echo ok')).toBe(true);
    expect(isVacuousVerify('ECHO   OK')).toBe(true);
    expect(isVacuousVerify('echo')).toBe(true);
    expect(isVacuousVerify('pass')).toBe(true);

    // Near-miss negative test: command containing 'true' as substring is NOT vacuous
    expect(isVacuousVerify('npm test || true')).toBe(false);
    expect(isVacuousVerify('vitest run')).toBe(false);
  });

  it('taskGaps identifies missing fields correctly', () => {
    expect(taskGaps({})).toEqual(['title', 'intent', 'verify_cmd', 'verify_confirmed']);

    expect(
      taskGaps({
        title: 'Fix Bug',
        intent: 'Fix login error',
        verify_cmd: 'exit 0' // vacuous -> still a gap
      })
    ).toEqual(['verify_cmd', 'verify_confirmed']);

    expect(
      taskGaps({
        title: 'Fix Bug',
        intent: 'Fix login error',
        verify_cmd: 'npm test',
        verify_confirmed_at: new Date().toISOString(),
        verify_confirmed_by: 'human-operator'
      })
    ).toEqual([]);
  });

  it('tool schemas validate input and ProposeFieldSchema rejects verify_cmd', () => {
    expect(ProposeFieldSchema.safeParse({ field: 'title', value: 'Task Title' }).success).toBe(true);
    expect(ProposeFieldSchema.safeParse({ field: 'intent', value: 'Intent text' }).success).toBe(true);

    // Safety assertion: ProposeFieldSchema MUST reject field: 'verify_cmd'
    const verifyInField = ProposeFieldSchema.safeParse({ field: 'verify_cmd', value: 'npm test' });
    expect(verifyInField.success).toBe(false);

    expect(ProposeVerifySchema.safeParse({ command: 'npm test' }).success).toBe(true);
    expect(AskHumanSchema.safeParse({ question: 'Which library?' }).success).toBe(true);
    expect(FileTaskSchema.safeParse({}).success).toBe(true);
  });
});

const testImplementations = [
  { name: 'Fake DB', create: () => ({ db: createFakeDb(), cleanup: () => {} }) },
  {
    name: 'Real node:sqlite',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-m1-'));
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

describe.each(testImplementations)('M1 Database Schema & Constraints ($name)', ({ create }) => {
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

  it('enforces partial unique index on idempotency_key in bureau_intake_sessions', () => {
    const now = new Date().toISOString();
    const session1 = {
      id: 'sess-1',
      state: 'open',
      idempotency_key: 'idem-key-123',
      created_at: now,
      updated_at: now,
      actor_role: 'intake-officer',
      provider: 'ollama',
      model: 'llama3',
      account: null
    };

    db.run(
      `INSERT INTO bureau_intake_sessions (id, state, idempotency_key, created_at, updated_at, actor_role, provider, model, account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session1.id,
      session1.state,
      session1.idempotency_key,
      session1.created_at,
      session1.updated_at,
      session1.actor_role,
      session1.provider,
      session1.model,
      session1.account
    );

    // Duplicate idempotency_key must fail
    expect(() => {
      db.run(
        `INSERT INTO bureau_intake_sessions (id, state, idempotency_key, created_at, updated_at, actor_role, provider, model, account)
         VALUES ('sess-2', 'open', 'idem-key-123', ?, ?, 'intake-officer', 'ollama', 'llama3', NULL)`,
        now,
        now
      );
    }).toThrow();

    // Multiple NULL idempotency_keys must succeed
    db.run(
      `INSERT INTO bureau_intake_sessions (id, state, idempotency_key, created_at, updated_at, actor_role, provider, model, account)
       VALUES ('sess-3', 'open', NULL, ?, ?, 'intake-officer', 'ollama', 'llama3', NULL)`,
      now,
      now
    );
    db.run(
      `INSERT INTO bureau_intake_sessions (id, state, idempotency_key, created_at, updated_at, actor_role, provider, model, account)
       VALUES ('sess-4', 'open', NULL, ?, ?, 'intake-officer', 'ollama', 'llama3', NULL)`,
      now,
      now
    );
  });

  it('enforces append-only triggers on bureau_intake_messages', () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_intake_sessions (id, state, created_at, updated_at, actor_role, provider, model, account)
       VALUES ('sess-1', 'open', ?, ?, 'intake-officer', 'ollama', 'llama3', NULL)`,
      now,
      now
    );

    db.run(
      `INSERT INTO bureau_intake_messages (id, session_id, role, content, actor_role, provider, model, account, created_at)
       VALUES ('msg-1', 'sess-1', 'human', '{"text":"hello"}', 'human-operator', 'deterministic', 'core', NULL, ?)`,
      now
    );

    // UPDATE raises trigger error
    expect(() => {
      db.run(`UPDATE bureau_intake_messages SET content = '{"text":"modified"}' WHERE id = 'msg-1'`);
    }).toThrow(/bureau_intake_messages is append-only/);

    // DELETE raises trigger error
    expect(() => {
      db.run(`DELETE FROM bureau_intake_messages WHERE id = 'msg-1'`);
    }).toThrow(/bureau_intake_messages is append-only/);
  });

  it('allows claimed -> blocked state transition under senior-engineer role and refuses unauthorized roles', () => {
    const { transition, canTransition } = require('../../engine/state/machine.ts');
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO bureau_tasks (id, title, state, work_uuid, created_at, updated_at)
       VALUES ('task-blocked-test', 'Blocked Test Task', 'claimed', 'work-123', ?, ?)`,
      now,
      now
    );

    // Can transition check
    expect(canTransition('claimed', 'blocked', 'senior-engineer')).toBe(true);
    expect(canTransition('claimed', 'blocked', 'junior-engineer')).toBe(false);

    // Illegal role transition throws
    expect(() => {
      transition(db, 'task-blocked-test', 'blocked', {
        actor_role: 'junior-engineer',
        provider: 'ollama',
        model: 'coder',
        account: null
      });
    }).toThrow(/Illegal state transition/);

    // Legal senior-engineer role transition succeeds
    const updated = transition(db, 'task-blocked-test', 'blocked', {
      actor_role: 'senior-engineer',
      provider: 'deterministic',
      model: 'rubric',
      account: null
    });

    expect(updated.state).toBe('blocked');
  });
});
