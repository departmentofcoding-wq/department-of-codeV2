/**
 * One-shot, idempotent reconciliation of the live task list. The Operator
 * Console's Tasks view carried four rows that no longer reflect reality:
 *
 *   • Two "Add subtract() to math.js" rows (`live-mt0xey1w`, `live-mt0xgoxz`)
 *     are pipeline-verification test artifacts that leaked into db/bureau.db —
 *     no intake session, never real work (the live-DB scar). → ARCHIVED.
 *   • The Assets-tab task (`82b97764…`) and the ntfy task (`e489b734…`) both
 *     SHIPPED via the Senior review+merge path (c7f9b37, 1c14534), but their DB
 *     rows never travelled the verify/approve door, so they sit stuck at
 *     queued/claimed. → tagged COMPLETED (shipped), recording the shipping
 *     commit — NOT a forged state-machine `done` (the done-gate stays absolute;
 *     see docs/DEPARTMENT_STATUS). If a prior run archived them, they are first
 *     un-archived so completion is their single, correct close-out.
 *
 * Neither archive nor completion touches `state`. Every act is journaled and
 * reversible (unarchive / reopen). Re-running this script is a no-op.
 *
 *   node --experimental-strip-types scripts/reconcile_live_tasks.ts
 *
 * Set BUREAU_DB_PATH to target a non-live database.
 */
import { openDbConnection } from '../engine/db/index.ts';
import { archiveTask, unarchiveTask } from '../engine/state/archive.ts';
import { markTaskCompleted } from '../engine/state/completion.ts';
import type { AttributionTuple, BureauTaskRow } from '../engine/contract/types.ts';

const OPERATOR: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'operator',
  account: 'operator'
};

/** Test artifacts that leaked into the live DB — set aside. */
const ARCHIVE: Array<{ id: string; reason: string }> = [
  {
    id: 'live-mt0xey1w',
    reason: 'Test artifact — "Add subtract() to math.js" pipeline-verification run (no intake session)'
  },
  {
    id: 'live-mt0xgoxz',
    reason: 'Test artifact — "Add subtract() to math.js" pipeline-verification run (no intake session)'
  }
];

/** Real work that shipped out-of-band via the Senior review+merge path — tagged
 *  completed, recording the shipping commit. */
const COMPLETE: Array<{ id: string; commit: string; note: string }> = [
  {
    id: '82b97764-ad52-4a50-ab19-21ecbc8bfcd3',
    commit: 'c7f9b37',
    note: 'Shipped out-of-band: Assets tab merged as c7f9b37 (Senior verdict 0a1100a). Delivered via review+merge, not the DB verify/approve door.'
  },
  {
    id: 'e489b734-33ee-4a3f-b698-b24ab5403d09',
    commit: '1c14534',
    note: 'Shipped out-of-band: ntfy notifications merged as 1c14534 (Senior verdict f349a13). Delivered via review+merge, not the DB verify/approve door.'
  }
];

async function main(): Promise<void> {
  const db = openDbConnection();
  try {
    for (const { id, reason } of ARCHIVE) {
      const row = db.get<BureauTaskRow>('SELECT id, state, archived_at FROM bureau_tasks WHERE id = ?', id);
      if (!row) {
        console.log(`[reconcile] SKIP ${id} — not present`);
        continue;
      }
      if (row.archived_at) {
        console.log(`[reconcile] SKIP ${id} — already archived`);
        continue;
      }
      const updated = archiveTask(db, id, OPERATOR, reason);
      console.log(`[reconcile] ARCHIVED ${id} (was '${row.state}') — ${updated.archive_reason}`);
    }

    for (const { id, commit, note } of COMPLETE) {
      const row = db.get<BureauTaskRow>(
        'SELECT id, state, archived_at, completed_at FROM bureau_tasks WHERE id = ?',
        id
      );
      if (!row) {
        console.log(`[reconcile] SKIP ${id} — not present`);
        continue;
      }
      // A prior run may have archived these; completion is the correct close-out,
      // so lift the archive first.
      if (row.archived_at) {
        unarchiveTask(db, id, OPERATOR);
        console.log(`[reconcile] UN-ARCHIVED ${id} (completion is the correct close-out)`);
      }
      if (row.completed_at) {
        console.log(`[reconcile] SKIP ${id} — already completed`);
        continue;
      }
      const updated = markTaskCompleted(db, id, OPERATOR, { commit, note });
      console.log(`[reconcile] COMPLETED ${id} (was '${row.state}') — shipped in ${updated.completion_commit}`);
    }

    const live = db.all<{ id: string; title: string; state: string }>(
      'SELECT id, title, state FROM bureau_tasks WHERE archived_at IS NULL AND completed_at IS NULL ORDER BY created_at DESC'
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
