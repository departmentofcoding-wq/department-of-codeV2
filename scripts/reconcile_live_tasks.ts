/**
 * One-shot, idempotent reconciliation of the live task list. The Operator
 * Console's Tasks view carried four rows that no longer reflect reality:
 *
 *   • Two "Add subtract() to math.js" rows (`live-mt0xey1w`, `live-mt0xgoxz`)
 *     are pipeline-verification test artifacts that leaked into db/bureau.db —
 *     no intake session, never real work (the live-DB scar).
 *   • The Assets-tab task (`82b97764…`) and the ntfy task (`e489b734…`) both
 *     SHIPPED via the Senior review+merge path (c7f9b37, 1c14534), but their DB
 *     rows never travelled the verify/approve door, so they sit stuck at
 *     queued/claimed. Their honest close-out is "shipped out-of-band" — NOT a
 *     forged `done` (the done-gate stays absolute; see docs/DEPARTMENT_STATUS).
 *
 * Archiving records all four under a reason and clears them from the live list
 * without touching `state`. Every archive is journaled and reversible
 * (unarchive). Re-running this script is a no-op.
 *
 *   node --experimental-strip-types scripts/reconcile_live_tasks.ts
 *
 * Set BUREAU_DB_PATH to target a non-live database.
 */
import { openDbConnection } from '../engine/db/index.ts';
import { archiveTask } from '../engine/state/archive.ts';
import type { AttributionTuple, BureauTaskRow } from '../engine/contract/types.ts';

const OPERATOR: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'operator',
  account: 'operator'
};

const RECONCILE: Array<{ id: string; reason: string }> = [
  {
    id: 'live-mt0xey1w',
    reason: 'Test artifact — "Add subtract() to math.js" pipeline-verification run (no intake session)'
  },
  {
    id: 'live-mt0xgoxz',
    reason: 'Test artifact — "Add subtract() to math.js" pipeline-verification run (no intake session)'
  },
  {
    id: '82b97764-ad52-4a50-ab19-21ecbc8bfcd3',
    reason: 'Shipped out-of-band: Assets tab merged as c7f9b37 (Senior verdict 0a1100a). DB row never travelled the verify/approve door — worktree reconciliation is a separate stream.'
  },
  {
    id: 'e489b734-33ee-4a3f-b698-b24ab5403d09',
    reason: 'Shipped out-of-band: ntfy notifications merged as 1c14534 (Senior verdict f349a13). DB row never travelled the verify/approve door — worktree reconciliation is a separate stream.'
  }
];

async function main(): Promise<void> {
  const db = openDbConnection();
  try {
    for (const { id, reason } of RECONCILE) {
      const row = db.get<BureauTaskRow>('SELECT id, state, archived_at FROM bureau_tasks WHERE id = ?', id);
      if (!row) {
        console.log(`[reconcile] SKIP ${id} — not present in this database`);
        continue;
      }
      if (row.archived_at) {
        console.log(`[reconcile] SKIP ${id} — already archived (${row.archived_at})`);
        continue;
      }
      const updated = archiveTask(db, id, OPERATOR, reason);
      console.log(`[reconcile] ARCHIVED ${id} (was '${row.state}') — ${updated.archive_reason}`);
    }

    const live = db.all<{ id: string; title: string; state: string }>(
      'SELECT id, title, state FROM bureau_tasks WHERE archived_at IS NULL ORDER BY created_at DESC'
    );
    console.log(`\n[reconcile] Live task list is now ${live.length} row(s):`);
    for (const t of live) console.log(`   • ${t.id}  [${t.state}]  ${t.title}`);
  } finally {
    (db as any).close?.();
  }
}

main().catch((err) => {
  console.error('[reconcile] FAILED:', err);
  process.exit(1);
});
