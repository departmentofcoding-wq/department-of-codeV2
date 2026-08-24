import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import { taskFlow, FLOW_STAGES, FLOW_STALL_WINDOW_MS } from '../../engine/dashboards/views.ts';
import { archiveTask } from '../../engine/state/archive.ts';
import { journal } from '../../engine/journal/writer.ts';
import type { DbConnection, AttributionTuple } from '../../engine/contract/types.ts';

const OPERATOR: AttributionTuple = { actor_role: 'human-operator', provider: 'human', model: 'operator', account: 'operator' };

function insertTask(db: DbConnection, id: string, state: string): void {
  // A 'done' row must satisfy the done-gate CHECK (verifier 0 + human approval).
  const done = state === 'done';
  db.run(
    `INSERT INTO bureau_tasks (id, title, state, verifier_exit_code, approved_at, approved_by, priority, work_uuid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    id, `Task ${id}`, state,
    done ? 0 : null,
    done ? '2026-08-20T00:00:00.000Z' : null,
    done ? 'operator' : null,
    `work-${id}`
  );
}

describe('taskFlow pipeline projection', () => {
  let db: DbConnection & { close: () => void };

  beforeEach(() => { db = createFakeDb(); });
  afterEach(() => { db.close(); });

  it('maps each state to its pipeline stage and excludes done + archived', () => {
    insertTask(db, 'q', 'queued');
    insertTask(db, 'c', 'claimed');
    insertTask(db, 'nr', 'needs-review');
    insertTask(db, 'd', 'done');            // terminal — excluded
    insertTask(db, 'arc', 'blocked');
    archiveTask(db, 'arc', OPERATOR, 'set aside'); // archived — excluded

    const flow = taskFlow(db);
    const ids = flow.map(f => f.task_id).sort();
    expect(ids).toEqual(['c', 'nr', 'q']);

    const byId = Object.fromEntries(flow.map(f => [f.task_id, f]));
    expect(byId['q'].stage_label).toBe('Queued');
    expect(byId['c'].stage_label).toBe('In progress');
    expect(byId['nr'].stage_label).toBe('Review');
    expect(byId['c'].responsible_role).toBe('junior-engineer');
    expect(FLOW_STAGES[byId['nr'].stage_index]).toBe('Review');
  });

  it('flags blocked/failed tasks as stuck with a reason', () => {
    insertTask(db, 'b', 'blocked');
    insertTask(db, 'f', 'failed');
    const flow = taskFlow(db);
    const byId = Object.fromEntries(flow.map(f => [f.task_id, f]));
    expect(byId['b'].is_stuck).toBe(true);
    expect(byId['b'].stuck_reason).toMatch(/Blocked/);
    expect(byId['f'].is_stuck).toBe(true);
    expect(byId['f'].stuck_reason).toMatch(/Failed/);
  });

  it('flags a stalled task (no recent activity) and surfaces the last actor', () => {
    insertTask(db, 's', 'claimed');
    // A journal act older than the stall window.
    const stale = new Date(Date.now() - FLOW_STALL_WINDOW_MS - 60_000).toISOString();
    db.run(
      `INSERT INTO bureau_journal (ts, kind, actor_role, provider, model, account, task_id, detail)
       VALUES (?, 'observation', 'junior-engineer', 'antigravity', 'gemini', NULL, 's', '{}')`,
      stale
    );
    const flow = taskFlow(db);
    const s = flow.find(f => f.task_id === 's')!;
    expect(s.is_stuck).toBe(true);
    expect(s.stuck_reason).toMatch(/Stalled/);
    expect(s.last_actor_role).toBe('junior-engineer');
  });

  it('a claimed task with a fresh act is moving, not stuck', () => {
    insertTask(db, 'm', 'claimed');
    journal(db, {
      kind: 'observation',
      attribution: { actor_role: 'junior-engineer', provider: 'antigravity', model: 'gemini', account: null },
      taskId: 'm',
      detail: { note: 'working' }
    });
    const m = taskFlow(db).find(f => f.task_id === 'm')!;
    expect(m.is_stuck).toBe(false);
  });
});
