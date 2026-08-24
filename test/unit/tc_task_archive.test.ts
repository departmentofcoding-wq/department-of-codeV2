import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { archiveTask, unarchiveTask } from '../../engine/state/archive.ts';
import type { DbConnection, BureauTaskRow, AttributionTuple } from '../../engine/contract/types.ts';

const OPERATOR: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'operator',
  account: 'operator'
};

function insertTask(db: DbConnection, id: string, state: string): void {
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    id, `Task ${id}`, state, `work-${id}`
  );
}

describe('Task archive door', () => {
  let db: DbConnection & { close: () => void };

  beforeEach(() => { db = createFakeDb(); });
  afterEach(() => { db.close(); });

  it('archives a task without touching its state and journals the act', () => {
    insertTask(db, 't1', 'blocked');
    const row = archiveTask(db, 't1', OPERATOR, 'test artifact');

    expect(row.archived_at).not.toBeNull();
    expect(row.archived_by).toContain('human-operator');
    expect(row.archive_reason).toBe('test artifact');
    // State is untouched — archiving is orthogonal to the state machine.
    expect(row.state).toBe('blocked');

    const span = db.get<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM bureau_journal WHERE detail LIKE '%"action":"archive"%'`
    );
    expect(span?.kind).toBe('human');
    expect(span?.detail).toContain('test artifact');
  });

  it('is idempotent: re-archiving is a no-op with no second journal span', () => {
    insertTask(db, 't2', 'queued');
    archiveTask(db, 't2', OPERATOR, 'first');
    const again = archiveTask(db, 't2', OPERATOR, 'second');
    expect(again.archive_reason).toBe('first'); // unchanged

    const count = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bureau_journal WHERE detail LIKE '%"action":"archive"%'`
    );
    expect(count?.c).toBe(1);
  });

  it('unarchive restores the row to the live list', () => {
    insertTask(db, 't3', 'needs-review');
    archiveTask(db, 't3', OPERATOR);
    const restored = unarchiveTask(db, 't3', OPERATOR);
    expect(restored.archived_at).toBeNull();
    expect(restored.archived_by).toBeNull();
    expect(restored.archive_reason).toBeNull();
  });

  it('refuses a non-operator actor (fail-closed)', () => {
    insertTask(db, 't4', 'claimed');
    expect(() => archiveTask(db, 't4', { ...OPERATOR, actor_role: 'junior-engineer' }))
      .toThrow(/human-operator/);
    const row = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', 't4');
    expect(row?.archived_at).toBeNull();
  });

  it('refuses an unknown task', () => {
    expect(() => archiveTask(db, 'nope', OPERATOR)).toThrow(/not found/);
  });

  it('does NOT let archiving forge a done: the done-gate CHECK still bites', () => {
    // Archiving a task that never passed verify/approve must not make it done.
    insertTask(db, 't5', 'claimed');
    archiveTask(db, 't5', OPERATOR, 'shipped out-of-band via merge abc123');
    // Attempting to flip an unverified task to done still violates the CHECK.
    expect(() =>
      db.run(`UPDATE bureau_tasks SET state = 'done' WHERE id = 't5'`)
    ).toThrow();
    const row = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', 't5');
    expect(row?.state).toBe('claimed');
  });
});
