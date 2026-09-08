/**
 * Operator switch for junior auto-warmup (docs/plan-junior-auto-warmup.md §3.4,
 * senior Rec5). The warmer deliberately ignores the admission cooldown meta
 * (plan §4.1 — a cooldown-gated warmer would self-deadlock), so the operator's
 * keep-juniors-down control is this dedicated key, not a manual cooldown.
 *
 * Usage: npm run junior:warmup -- off|on|status
 *   off    — set bureau_meta['junior_warmup:disabled']; the warmer stops
 *            opening juniors (manual `npm run junior` remains the force-open).
 *   on     — clear the key; warming resumes (boot-gated + probe-fail-triggered).
 *   status — print the switch + each junior's admission-cooldown state.
 * Every set/clear is journaled as a human act.
 */
import { openDbConnection } from '../engine/db/index.ts';
import { journal } from '../engine/journal/writer.ts';
import { JUNIOR_WARMUP_DISABLED_KEY } from '../engine/flow/junior-warmer.ts';
import { isJuniorHealthy } from '../engine/flow/junior-health.ts';
import { freeJuniors } from '../engine/flow/assignment.ts';

const HUMAN_ATTRIBUTION = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'operator',
  account: 'operator'
} as const;

const command = process.argv[2];

function printStatus(db: ReturnType<typeof openDbConnection>): void {
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    JUNIOR_WARMUP_DISABLED_KEY
  );
  const disabled = !!row?.value;
  console.log(`junior auto-warmup: ${disabled ? 'DISABLED' : 'enabled'}`);
  for (const junior of freeJuniors()) {
    console.log(
      `  junior ${junior}: admission cooldown ${isJuniorHealthy(db, junior) ? 'clear' : 'ACTIVE'}`
    );
  }
}

async function main(): Promise<void> {
  if (command !== 'off' && command !== 'on' && command !== 'status') {
    console.error('Usage: npm run junior:warmup -- off|on|status');
    process.exitCode = 1;
    return;
  }
  const db = openDbConnection(process.env.BUREAU_DB_PATH);
  try {
    if (command === 'status') {
      printStatus(db);
      return;
    }
    if (command === 'off') {
      db.run(
        `INSERT INTO bureau_meta (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JUNIOR_WARMUP_DISABLED_KEY
      );
    } else {
      db.run('DELETE FROM bureau_meta WHERE key = ?', JUNIOR_WARMUP_DISABLED_KEY);
    }
    journal(db, {
      kind: 'human',
      attribution: HUMAN_ATTRIBUTION,
      detail: { action: 'junior_warmup_switch', command, key: JUNIOR_WARMUP_DISABLED_KEY }
    });
    console.log(`junior auto-warmup ${command === 'off' ? 'DISABLED' : 'enabled'}`);
    printStatus(db);
  } finally {
    db.close();
  }
}

void main();
