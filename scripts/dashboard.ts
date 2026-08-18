/**
 * Read-only dashboard CLI — Milestone B2.
 *
 * Renders the department's health from the live DB (or a --db path) without
 * writing a single row. Pure projection over engine/dashboards/views.ts.
 *
 *   node --experimental-strip-types scripts/dashboard.ts [--db <path>]
 */
import { openDbConnection, closeDatabase } from '../engine/db/index.ts';
import { dashboardSnapshot } from '../engine/dashboards/views.ts';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dbPath = argValue('--db');
  const db = openDbConnection(dbPath);
  try {
    const s = dashboardSnapshot(db);

    console.log('=== DEPARTMENT OF CODE — DASHBOARD (read-only) ===\n');

    console.log('Task state populations:');
    if (s.statePopulations.length === 0) console.log('  (no tasks)');
    for (const r of s.statePopulations) console.log(`  ${r.state.padEnd(14)} ${r.count}`);

    console.log('\nBudget spend per task (plan/verify/cycles/attempts/recover):');
    if (s.budgetSpend.length === 0) console.log('  (no tasks)');
    for (const t of s.budgetSpend) {
      console.log(
        `  ${t.task_id.slice(0, 12).padEnd(13)} ${t.state.padEnd(12)} ` +
        `${t.plan_rounds}/${t.verify_fixes}/${t.cycles}/${t.attempts}/${t.recover_attempts}  ${t.title ?? ''}`
      );
    }

    const v = s.verifyFailureRate;
    console.log(
      `\nVerify failure rate: ${v.failures}/${v.total_runs} ` +
      `(${(v.failure_rate * 100).toFixed(1)}%)`
    );

    console.log('\nJournal span kinds:');
    for (const k of s.spanKindCounts) console.log(`  ${k.kind.padEnd(12)} ${k.count}`);
    console.log(`\nGuardrail spans (refused acts): ${s.guardrailCount}`);
  } finally {
    closeDatabase();
  }
}

main();
