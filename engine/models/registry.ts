import type { DbConnection } from '../contract/index.ts';
import type { BureauAssignmentRow, BureauModelRow } from '../contract/index.ts';

export function registerModel(
  db: DbConnection,
  model: {
    id: string;
    provider: string;
    display: string;
    price_in_usd_per_mtok?: number | null;
    price_out_usd_per_mtok?: number | null;
    enabled?: number;
    notes?: string | null;
  }
): BureauModelRow {
  const stmt = db.prepare(`
    INSERT INTO bureau_models (
      id, provider, display, price_in_usd_per_mtok, price_out_usd_per_mtok, enabled, notes
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      display = excluded.display,
      price_in_usd_per_mtok = excluded.price_in_usd_per_mtok,
      price_out_usd_per_mtok = excluded.price_out_usd_per_mtok,
      enabled = excluded.enabled,
      notes = excluded.notes
    RETURNING *
  `);

  return stmt.get(
    model.id,
    model.provider,
    model.display,
    model.price_in_usd_per_mtok ?? null,
    model.price_out_usd_per_mtok ?? null,
    model.enabled ?? 1,
    model.notes ?? null
  ) as unknown as BureauModelRow;
}

export function getModel(db: DbConnection, id: string): BureauModelRow | null {
  const stmt = db.prepare('SELECT * FROM bureau_models WHERE id = ?');
  const row = stmt.get(id);
  return row ? (row as unknown as BureauModelRow) : null;
}

export function listModels(db: DbConnection): BureauModelRow[] {
  const stmt = db.prepare('SELECT * FROM bureau_models ORDER BY id ASC');
  return stmt.all() as unknown as BureauModelRow[];
}

export function assignRole(
  db: DbConnection,
  role: string,
  backend: string,
  modelId: string | null
): BureauAssignmentRow {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO bureau_assignments (role, backend, model_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(role) DO UPDATE SET
      backend = excluded.backend,
      model_id = excluded.model_id,
      updated_at = excluded.updated_at
    RETURNING *
  `);

  return stmt.get(role, backend, modelId, now) as unknown as BureauAssignmentRow;
}

export function getAssignment(db: DbConnection, role: string): BureauAssignmentRow | null {
  const stmt = db.prepare('SELECT * FROM bureau_assignments WHERE role = ?');
  const row = stmt.get(role);
  return row ? (row as unknown as BureauAssignmentRow) : null;
}

export function listAssignments(db: DbConnection): BureauAssignmentRow[] {
  const stmt = db.prepare('SELECT * FROM bureau_assignments ORDER BY role ASC');
  return stmt.all() as unknown as BureauAssignmentRow[];
}
