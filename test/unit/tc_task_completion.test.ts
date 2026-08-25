import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { markTaskCompleted, reopenTask } from '../../engine/state/completion.ts';
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

describe('Task completion tag', () => {
  let db: DbConnection & { close: () => void };

  beforeEach(() => { db = createFakeDb(); });
  afterEach(() => { db.close(); });

  it('tags a task completed with commit + note without touching its state', () => {
    insertTask(db, 't1', 'claimed');
    const row = markTaskCompleted(db, 't1', OPERATOR, { commit: 'c7f9b37', note: 'shipped out-of-band' });

    expect(row.completed_at).not.toBeNull();
    expect(row.completed_by).toContain('human-operator');
    expect(row.completion_commit).toBe('c7f9b37');
    expect(row.completion_note).toBe('shipped out-of-band');
    // State is untouched — completion is orthogonal to the state machine.
    expect(row.state).toBe('claimed');

    const span = db.get<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM bureau_journal WHERE detail LIKE '%"action":"complete"%'`
    );
    expect(span?.kind).toBe('human');
    expect(span?.detail).toContain('c7f9b37');
  });

  it('is idempotent: re-completing is a no-op with no second journal span', () => {
    insertTask(db, 't2', 'queued');
    markTaskCompleted(db, 't2', OPERATOR, { commit: 'aaa' });
    const again = markTaskCompleted(db, 't2', OPERATOR, { commit: 'bbb' });
    expect(again.completion_commit).toBe('aaa'); // unchanged
    const count = db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bureau_journal WHERE detail LIKE '%"action":"complete"%'`
    );
    expect(count?.c).toBe(1);
  });

  it('reopen clears the completed tag', () => {
    insertTask(db, 't3', 'needs-review');
    markTaskCompleted(db, 't3', OPERATOR, { commit: 'zzz' });
    const restored = reopenTask(db, 't3', OPERATOR);
    expect(restored.completed_at).toBeNull();
    expect(restored.completion_commit).toBeNull();
    expect(restored.completion_note).toBeNull();
  });

  it('refuses a non-operator actor (fail-closed)', () => {
    insertTask(db, 't4', 'claimed');
    expect(() => markTaskCompleted(db, 't4', { ...OPERATOR, actor_role: 'junior-engineer' }))
      .toThrow(/human-operator/);
    const row = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', 't4');
    expect(row?.completed_at).toBeNull();
  });

  it('does NOT let completion forge a done: the done-gate CHECK still bites', () => {
    insertTask(db, 't5', 'claimed');
    markTaskCompleted(db, 't5', OPERATOR, { commit: 'abc123', note: 'shipped' });
    // Tagging complete must not make the row a state-machine `done`.
    expect(() => db.run(`UPDATE bureau_tasks SET state = 'done' WHERE id = 't5'`)).toThrow();
    const row = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', 't5');
    expect(row?.state).toBe('claimed');
  });
});
