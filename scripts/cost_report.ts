/**
 * Cost report (A5) — a monthly-style cost rollup over the live journal.
 *
 *   node --experimental-strip-types scripts/cost_report.ts           # all time
 *   node --experimental-strip-types scripts/cost_report.ts --since 2026-08-01
 *   node --experimental-strip-types scripts/cost_report.ts --month 2026-08
 *
 * Honest by construction: recorded dollars and computed dollars are shown
 * separately, and any real token spend the ledger cannot price is flagged — the
 * total is a FLOOR whenever unpriced spend exists, never silently $0.
 */
import { openDbConnection } from '../engine/db/index.ts';
import { getPeriodCostRollup } from '../engine/ledger/rollups.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function monthWindow(month: string): { sinceIso: string; untilIso: string } {
  const [y, m] = month.split('-').map(Number);
  const since = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const until = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString();
  return { sinceIso: since, untilIso: until };
}

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function main(): void {
  const db = openDbConnection(process.env.BUREAU_DB_PATH || 'db/bureau.db');

  const month = arg('--month');
  const opts = month ? monthWindow(month) : { sinceIso: arg('--since'), untilIso: arg('--until') };
  const roll = getPeriodCostRollup(db, opts);

  const scope = roll.since || roll.until ? `${roll.since ?? 'start'} … ${roll.until ?? 'now'}` : 'all time';
  console.log(`\n=== Cost rollup (${scope}) ===`);
  console.log(`recorded:  ${usd(roll.recorded_cost_usd)}   (dollars spans actually carried)`);
  console.log(`computed:  ${usd(roll.computed_cost_usd)}   (tokens × model price, where priced)`);
  console.log(`TOTAL:     ${usd(roll.total_cost_usd)}${roll.has_unpriced_spend ? '   (FLOOR — some spend is unpriced)' : ''}`);
  if (roll.has_unpriced_spend) {
    console.log(`unpriced:  ${roll.unpriced_acts} act(s) spent tokens with no known price — set prices to value them.`);
  }

  console.log(`\nper model:`);
  for (const m of roll.models) {
    if (m.acts === 0) continue;
    console.log(
      `  ${m.provider}/${m.model}  acts=${m.acts}  tok=${m.tokens_in}in/${m.tokens_out}out  ` +
        `total=${usd(m.total_cost_usd)}  basis=${m.cost_basis}` +
        (m.unpriced_acts > 0 ? `  (${m.unpriced_acts} unpriced)` : '')
    );
  }
  console.log('');
}

if (process.argv[1]?.endsWith('cost_report.ts')) {
  main();
}
