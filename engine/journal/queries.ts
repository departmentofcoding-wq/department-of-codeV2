import type { DbConnection } from '../contract/index.ts';
import type { BureauJournalRow, TimelineQueryFilters } from '../contract/index.ts';

export function forTask(db: DbConnection, taskId: string): BureauJournalRow[] {
  const stmt = db.prepare('SELECT * FROM bureau_journal WHERE task_id = ? ORDER BY id ASC');
  return stmt.all(taskId) as unknown as BureauJournalRow[];
}

export function forWork(db: DbConnection, workUuid: string): BureauJournalRow[] {
  const stmt = db.prepare('SELECT * FROM bureau_journal WHERE work_uuid = ? ORDER BY id ASC');
  return stmt.all(workUuid) as unknown as BureauJournalRow[];
}

export function timeline(db: DbConnection, filters: TimelineQueryFilters = {}): BureauJournalRow[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.taskId) {
    conditions.push('task_id = ?');
    params.push(filters.taskId);
  }
  if (filters.workUuid) {
    conditions.push('work_uuid = ?');
    params.push(filters.workUuid);
  }
  if (filters.kind) {
    conditions.push('kind = ?');
    params.push(filters.kind);
  }
  if (filters.actorRole) {
    conditions.push('actor_role = ?');
    params.push(filters.actorRole);
  }

  let sql = 'SELECT * FROM bureau_journal';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY id ASC';

  if (filters.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
    if (filters.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(filters.offset);
    }
  }

  const stmt = db.prepare(sql);
  return stmt.all(...params) as unknown as BureauJournalRow[];
}
