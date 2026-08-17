import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDbConnection, closeDatabase } from '../db/index.ts';
import { journal, forTask, forWork, timeline } from './index.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AttributionTuple } from '../contract/index.ts';

describe('A3: Append-Only Journal', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-journal-'));
    dbPath = path.join(tempDir, 'test.db');
    const db = openDbConnection(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const validAttr: AttributionTuple = {
    actor_role: 'senior-engineer',
    provider: 'zai',
    model: 'glm-5.2',
    account: 'zcode'
  };

  it('T2: UPDATE and DELETE on bureau_journal raise errors (append-only triggers)', () => {
    const db = openDbConnection(dbPath);
    const row = journal(db, {
      kind: 'system',
      attribution: validAttr,
      detail: { note: 'initial entry' }
    });

    expect(row.id).toBeDefined();

    // UPDATE attempt
    expect(() => {
      db.exec(`UPDATE bureau_journal SET kind = 'tool' WHERE id = ${row.id}`);
    }).toThrow(/bureau_journal is append-only/);

    // DELETE attempt
    expect(() => {
      db.exec(`DELETE FROM bureau_journal WHERE id = ${row.id}`);
    }).toThrow(/bureau_journal is append-only/);
  });

  it('journal throws if attribution or model is missing', () => {
    const db = openDbConnection(dbPath);

    expect(() => {
      journal(db, {
        kind: 'system',
        attribution: null as any
      });
    }).toThrow(/Journal entry requires attribution/);

    expect(() => {
      journal(db, {
        kind: 'system',
        attribution: { actor_role: 'junior-engineer', provider: 'antigravity', model: '', account: null }
      });
    }).toThrow(/missing required attribution fields/);
  });

  it('backfills work_uuid and work_title from bureau_tasks when omitted', () => {
    const db = openDbConnection(dbPath);
    const now = new Date().toISOString();
    
    db.prepare(`
      INSERT INTO bureau_tasks (id, title, work_uuid, work_title, created_at, updated_at)
      VALUES ('task-100', 'Fix Login Bug', 'work-uuid-999', 'Authentication Sprint', ?, ?)
    `).run(now, now);

    const row = journal(db, {
      kind: 'tool',
      attribution: validAttr,
      taskId: 'task-100'
    });

    expect(row.work_uuid).toBe('work-uuid-999');
    expect(row.work_title).toBe('Authentication Sprint');
  });

  it('query helpers forTask, forWork, timeline return matching spans', () => {
    const db = openDbConnection(dbPath);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES ('t1', 'T1', 'w1', ?, ?)").run(now, now);
    db.prepare("INSERT INTO bureau_tasks (id, title, work_uuid, created_at, updated_at) VALUES ('t2', 'T2', 'w2', ?, ?)").run(now, now);

    journal(db, { kind: 'llm', attribution: validAttr, taskId: 't1', workUuid: 'w1' });
    journal(db, { kind: 'tool', attribution: validAttr, taskId: 't1', workUuid: 'w1' });
    journal(db, { kind: 'guardrail', attribution: validAttr, taskId: 't2', workUuid: 'w2' });

    expect(forTask(db, 't1')).toHaveLength(2);
    expect(forWork(db, 'w1')).toHaveLength(2);
    expect(timeline(db, { kind: 'guardrail' })).toHaveLength(1);
  });

  it('rejects a kind outside SPAN_KINDS — the record is permanent, a typo would be forever', () => {
    const db = openDbConnection(dbPath);

    expect(() => {
      journal(db, { kind: 'transiton' as any, attribution: validAttr });
    }).toThrow(/not one of/);
  });
});
