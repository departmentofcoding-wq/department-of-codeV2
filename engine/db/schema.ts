import type { DatabaseSync } from 'node:sqlite';

export function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bureau_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      intent TEXT, spec TEXT, acceptance TEXT,
      verify_cmd TEXT, setup_cmd TEXT,
      state TEXT NOT NULL DEFAULT 'intake'
        CHECK (state IN ('intake','queued','claimed','verifying','needs-review','done','failed','blocked')),
      verifier_exit_code INTEGER,
      approved_at TEXT, approved_by TEXT,
      merged_at TEXT, merged_by TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      work_uuid TEXT NOT NULL,
      work_title TEXT,
      plan_rounds INTEGER NOT NULL DEFAULT 0,
      verify_fixes INTEGER NOT NULL DEFAULT 0,
      cycles INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      pull_request_url TEXT,
      intake_session_id TEXT,
      archived_at TEXT, archived_by TEXT, archive_reason TEXT,
      completed_at TEXT, completed_by TEXT, completion_commit TEXT, completion_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK (state <> 'done'
             OR (verifier_exit_code IS NOT NULL AND verifier_exit_code = 0 AND approved_at IS NOT NULL AND approved_by IS NOT NULL)),
      CHECK (merged_at IS NULL OR state = 'done')
    );

    CREATE TABLE IF NOT EXISTS bureau_worktrees (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE REFERENCES bureau_tasks(id),
      path TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ready','dirty','stale','removed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT
    );

    CREATE TABLE IF NOT EXISTS bureau_verify_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
      exit_code INTEGER,
      signal TEXT,
      timed_out INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      verify_fixes_before INTEGER NOT NULL,
      stdout_tail TEXT,
      stderr_tail TEXT,
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT
    );

    CREATE TABLE IF NOT EXISTS bureau_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      task_id TEXT REFERENCES bureau_tasks(id),
      payload TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','running','done','failed','dead')),
      run_after TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_owner TEXT, lease_expires_at TEXT,
      reaped_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bureau_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT,
      task_id TEXT REFERENCES bureau_tasks(id),
      work_uuid TEXT, work_title TEXT,
      job_id TEXT REFERENCES bureau_jobs(id),
      tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, latency_ms INTEGER,
      detail TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TRIGGER IF NOT EXISTS bureau_journal_no_update BEFORE UPDATE ON bureau_journal
    BEGIN SELECT RAISE(ABORT, 'bureau_journal is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS bureau_journal_no_delete BEFORE DELETE ON bureau_journal
    BEGIN SELECT RAISE(ABORT, 'bureau_journal is append-only'); END;

    CREATE TABLE IF NOT EXISTS bureau_models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display TEXT NOT NULL,
      price_in_usd_per_mtok REAL, price_out_usd_per_mtok REAL,
      enabled INTEGER NOT NULL DEFAULT 1, notes TEXT
    );

    CREATE TABLE IF NOT EXISTS bureau_assignments (
      role TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      model_id TEXT REFERENCES bureau_models(id),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_plans (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
      work_uuid TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      plan_text TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      account TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_plan_reviews (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES bureau_plans(id),
      task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
      verdict TEXT NOT NULL,
      feedback TEXT,
      actor_role TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      account TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_work_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
      work_uuid TEXT NOT NULL,
      phase TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      verdict TEXT NOT NULL,
      comments TEXT,
      reviewed_commit TEXT,
      actor_role TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      account TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_dispatches (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES bureau_tasks(id),
      work_uuid TEXT NOT NULL,
      job_id TEXT REFERENCES bureau_jobs(id),
      ide_model TEXT,
      ide_account TEXT,
      actor_role TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      account TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bureau_intake_sessions (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','filed','abandoned')),
      title TEXT, intent TEXT, spec TEXT, acceptance TEXT,
      verify_cmd TEXT, verify_confirmed_at TEXT, verify_confirmed_by TEXT,
      idempotency_key TEXT,
      model_calls INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_sessions_idempotency
    ON bureau_intake_sessions (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bureau_intake_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES bureau_intake_sessions(id),
      role TEXT NOT NULL CHECK (role IN ('human','officer','tool')),
      content TEXT NOT NULL DEFAULT '{}',
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT,
      tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS bureau_intake_messages_no_update BEFORE UPDATE ON bureau_intake_messages
    BEGIN SELECT RAISE(ABORT, 'bureau_intake_messages is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS bureau_intake_messages_no_delete BEFORE DELETE ON bureau_intake_messages
    BEGIN SELECT RAISE(ABORT, 'bureau_intake_messages is append-only'); END;

    CREATE TABLE IF NOT EXISTS bureau_selectors (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      css TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','calibrating','calibrated','failed')),
      match_count INTEGER NOT NULL DEFAULT 0,
      last_calibrated_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_window_leases (
      id TEXT PRIMARY KEY,
      window_target TEXT NOT NULL,
      dispatch_id TEXT NOT NULL REFERENCES bureau_dispatches(id),
      status TEXT NOT NULL CHECK (status IN ('active','released','expired','reaped')),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      heartbeats INTEGER NOT NULL DEFAULT 0,
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_window_leases_active
    ON bureau_window_leases (window_target)
    WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS bureau_observations (
      id TEXT PRIMARY KEY,
      dispatch_id TEXT NOT NULL REFERENCES bureau_dispatches(id),
      nonce TEXT UNIQUE NOT NULL,
      selector_key TEXT NOT NULL,
      observed TEXT NOT NULL DEFAULT '{}',
      actor_role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_ownership (
      key TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      holder_role TEXT NOT NULL,
      leased_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bureau_watchdog_findings (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES bureau_tasks(id),
      finding_class TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'detected',
      recovery_job_id TEXT REFERENCES bureau_jobs(id),
      detail TEXT,
      detected_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bureau_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      url TEXT NOT NULL,
      description TEXT,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function applyAddedColumns(
  db: DatabaseSync,
  tableName: string,
  newColumns: Array<{ name: string; definition: string }>
): void {
  const tableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
  if (!tableExists) {
    return;
  }
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
  const columns = stmt.all() as Array<{ name: string }>;
  const existingNames = new Set(columns.map(c => c.name));

  for (const col of newColumns) {
    if (!existingNames.has(col.name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.definition}`);
    }
  }
}

/**
 * Columns added to tables that already exist. CREATE TABLE IF NOT EXISTS is a
 * no-op against a live database, so a column that arrives after first boot has
 * to be ALTERed in — and SQLite has no ADD COLUMN IF NOT EXISTS, so pragma
 * table_info does the idempotency. Every entry must be nullable or carry a
 * constant DEFAULT (SQLite refuses otherwise).
 */
const ADDED_COLUMNS: Array<{ table: string; name: string; definition: string }> = [
  { table: 'bureau_tasks', name: 'intake_session_id', definition: 'TEXT' },
  { table: 'bureau_tasks', name: 'recover_attempts', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Archive is orthogonal to the state machine: archiving records that the
  // operator has set a task aside (test artifact, or shipped out-of-band via
  // the Senior review+merge path) WITHOUT touching `state`, so the done-gate
  // CHECK constraints stay absolute. archived_at IS NULL == a live task.
  { table: 'bureau_tasks', name: 'archived_at', definition: 'TEXT' },
  { table: 'bureau_tasks', name: 'archived_by', definition: 'TEXT' },
  { table: 'bureau_tasks', name: 'archive_reason', definition: 'TEXT' },
  // Completion is also orthogonal to the state machine: it TAGS a task the
  // operator considers finished/shipped (e.g. delivered out-of-band via the
  // Senior review+merge path, recording the shipping commit) without forging a
  // state-machine `done` — the done-gate CHECK (verifier 0 + human approval)
  // stays absolute. completed_at IS NULL == not marked complete.
  { table: 'bureau_tasks', name: 'completed_at', definition: 'TEXT' },
  { table: 'bureau_tasks', name: 'completed_by', definition: 'TEXT' },
  { table: 'bureau_tasks', name: 'completion_commit', definition: 'TEXT' },
  { table: 'bureau_tasks', name: 'completion_note', definition: 'TEXT' },
  { table: 'bureau_dispatches', name: 'attempts', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'bureau_work_reviews', name: 'reviewed_commit', definition: 'TEXT' },
  { table: 'bureau_watchdog_findings', name: 'subject_kind', definition: 'TEXT' },
  { table: 'bureau_watchdog_findings', name: 'subject_id', definition: 'TEXT' },
  { table: 'bureau_watchdog_findings', name: 'recover_attempts', definition: 'INTEGER NOT NULL DEFAULT 0' }
];

export function applyBootMigrations(db: DatabaseSync): void {
  // 1. ADDED_COLUMNS runs first so schema shape is up to date before table rebuild
  const byTable = new Map<string, Array<{ name: string; definition: string }>>();
  for (const { table, name, definition } of ADDED_COLUMNS) {
    const cols = byTable.get(table) ?? [];
    cols.push({ name, definition });
    byTable.set(table, cols);
  }
  for (const [table, columns] of byTable) {
    applyAddedColumns(db, table, columns);
  }

  // 2. Table Rebuild: Check if existing bureau_tasks DDL lacks 'blocked'
  const tableMaster = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='bureau_tasks'`).get() as { sql?: string } | undefined;
  if (tableMaster?.sql && !tableMaster.sql.includes("'blocked'")) {
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec('BEGIN IMMEDIATE;');
      db.exec(`
        CREATE TABLE bureau_tasks_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          intent TEXT, spec TEXT, acceptance TEXT,
          verify_cmd TEXT, setup_cmd TEXT,
          state TEXT NOT NULL DEFAULT 'intake'
            CHECK (state IN ('intake','queued','claimed','verifying','needs-review','done','failed','blocked')),
          verifier_exit_code INTEGER,
          approved_at TEXT, approved_by TEXT,
          merged_at TEXT, merged_by TEXT,
          priority INTEGER NOT NULL DEFAULT 1,
          work_uuid TEXT NOT NULL,
          work_title TEXT,
          plan_rounds INTEGER NOT NULL DEFAULT 0,
          verify_fixes INTEGER NOT NULL DEFAULT 0,
          cycles INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          recover_attempts INTEGER NOT NULL DEFAULT 0,
          pull_request_url TEXT,
          intake_session_id TEXT,
          archived_at TEXT, archived_by TEXT, archive_reason TEXT,
          completed_at TEXT, completed_by TEXT, completion_commit TEXT, completion_note TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          CHECK (state <> 'done'
                 OR (verifier_exit_code IS NOT NULL AND verifier_exit_code = 0 AND approved_at IS NOT NULL AND approved_by IS NOT NULL)),
          CHECK (merged_at IS NULL OR state = 'done')
        );

        INSERT INTO bureau_tasks_new (
          id, title, intent, spec, acceptance, verify_cmd, setup_cmd, state,
          verifier_exit_code, approved_at, approved_by, merged_at, merged_by,
          priority, work_uuid, work_title, plan_rounds, verify_fixes, cycles,
          attempts, recover_attempts, pull_request_url, intake_session_id,
          archived_at, archived_by, archive_reason,
          completed_at, completed_by, completion_commit, completion_note,
          created_at, updated_at
        )
        SELECT
          id, title, intent, spec, acceptance, verify_cmd, setup_cmd, state,
          verifier_exit_code, approved_at, approved_by, merged_at, merged_by,
          priority, work_uuid, work_title, plan_rounds, verify_fixes, cycles,
          attempts, recover_attempts, pull_request_url, intake_session_id,
          archived_at, archived_by, archive_reason,
          completed_at, completed_by, completion_commit, completion_note,
          created_at, updated_at
        FROM bureau_tasks;

        DROP TABLE bureau_tasks;
        ALTER TABLE bureau_tasks_new RENAME TO bureau_tasks;
      `);

      const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
      if (fkViolations.length > 0) {
        throw new Error(`Foreign key check failed after bureau_tasks rebuild: ${JSON.stringify(fkViolations)}`);
      }

      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Ignored if transaction already aborted
      }
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }


  // 3. Indices built after table rebuild completes and ADDED_COLUMNS have been applied
  const hasTasks = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='bureau_tasks'`).get();
  if (hasTasks) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_intake_session
      ON bureau_tasks (intake_session_id)
      WHERE intake_session_id IS NOT NULL;
    `);
  }

  const hasWindowLeases = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='bureau_window_leases'`).get();
  if (hasWindowLeases) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_window_leases_active
      ON bureau_window_leases (window_target)
      WHERE status = 'active';
    `);
  }

  const hasWatchdogFindings = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='bureau_watchdog_findings'`).get();
  if (hasWatchdogFindings) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchdog_findings_subject_active
      ON bureau_watchdog_findings (subject_kind, subject_id, finding_class)
      WHERE status IN ('detected', 'recovering');
    `);
  }
}

