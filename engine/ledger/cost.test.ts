import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDbConnection, closeDatabase } from '../db/index.ts';
import type { DbConnection } from '../contract/index.ts';
import { journal } from '../journal/writer.ts';
import { getModelPrice, setModelPrice, costOf } from './pricing.ts';
import { getModelAttributionRollups, getPeriodCostRollup } from './rollups.ts';

/**
 * A5 — cost accounting meets reality. Prices are per-model and updatable; the
 * rollup computes dollars from tokens × price where spans carried none, keeps
 * recorded/computed separate, and NEVER treats an unpriced model's real token
 * spend as $0 (the honesty flag). One period rollup sums it all with a floor flag.
 */
describe('A5: cost accounting', () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-a5-'));
    db = openDbConnection(path.join(tempDir, 'test.db'));
  });
  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function llmSpan(model: string, provider: string, tokensIn: number, tokensOut: number, costUsd: number | null) {
    journal(db, {
      kind: 'llm',
      attribution: { actor_role: 'task-intake-officer', provider, model, account: null },
      tokensIn,
      tokensOut,
      costUsd
    });
  }

  it('pricing resolves from meta first, then model columns, else null (unpriced)', () => {
    // Unknown model → unpriced.
    expect(getModelPrice(db, 'nope')).toBeNull();
    // Model-column price.
    db.run("INSERT INTO bureau_models (id, provider, display, price_in_usd_per_mtok, price_out_usd_per_mtok, enabled) VALUES ('m1','p','M1', 3, 15, 1)");
    expect(getModelPrice(db, 'm1')).toEqual({ inPerMtok: 3, outPerMtok: 15 });
    // Meta override wins and is updatable.
    setModelPrice(db, 'm1', { inPerMtok: 5, outPerMtok: 20 });
    expect(getModelPrice(db, 'm1')).toEqual({ inPerMtok: 5, outPerMtok: 20 });
    expect(costOf({ inPerMtok: 5, outPerMtok: 20 }, 1_000_000, 500_000)).toBeCloseTo(5 + 10, 6);
  });

  it('recorded cost is used as-is (back-compat: cost_usd / cost_recorded unchanged)', () => {
    llmSpan('glm-5.2', 'zai', 800, 250, 0.008);
    const r = getModelAttributionRollups(db).find((x) => x.model === 'glm-5.2')!;
    expect(r.cost_usd).toBeCloseTo(0.008, 6);
    expect(r.cost_recorded).toBe(true);
    expect(r.computed_cost_usd).toBe(0);
    expect(r.total_cost_usd).toBeCloseTo(0.008, 6);
    expect(r.cost_basis).toBe('recorded');
    expect(r.unpriced_acts).toBe(0);
  });

  it('computes cost from tokens × price when a priced span carried no cost', () => {
    setModelPrice(db, 'priced', { inPerMtok: 10, outPerMtok: 30 });
    llmSpan('priced', 'p', 1_000_000, 1_000_000, null); // no recorded cost
    const r = getModelAttributionRollups(db).find((x) => x.model === 'priced')!;
    expect(r.cost_usd).toBe(0);            // nothing recorded
    expect(r.cost_recorded).toBe(false);
    expect(r.computed_cost_usd).toBeCloseTo(40, 6); // 10 + 30
    expect(r.total_cost_usd).toBeCloseTo(40, 6);
    expect(r.cost_basis).toBe('computed');
    expect(r.unpriced_acts).toBe(0);
  });

  it('NEVER treats an unpriced model’s real token spend as $0 (the honesty flag)', () => {
    llmSpan('unpriced', 'x', 5000, 2000, null); // tokens spent, no price, no recorded cost
    const r = getModelAttributionRollups(db).find((x) => x.model === 'unpriced')!;
    expect(r.total_cost_usd).toBe(0);      // we cannot value it...
    expect(r.cost_basis).toBe('unpriced'); // ...but we say so, loudly
    expect(r.unpriced_acts).toBe(1);       // real spend the ledger can't price
    expect(r.tokens_in).toBe(5000);        // the tokens are still recorded
  });

  it('period rollup sums recorded + computed and flags unpriced spend as a floor', () => {
    setModelPrice(db, 'priced', { inPerMtok: 10, outPerMtok: 0 });
    llmSpan('glm-5.2', 'zai', 100, 50, 0.004);      // recorded
    llmSpan('priced', 'p', 2_000_000, 0, null);      // computed → $20
    llmSpan('unpriced', 'x', 9999, 1, null);         // unpriced

    const roll = getPeriodCostRollup(db);
    expect(roll.recorded_cost_usd).toBeCloseTo(0.004, 6);
    expect(roll.computed_cost_usd).toBeCloseTo(20, 6);
    expect(roll.total_cost_usd).toBeCloseTo(20.004, 6);
    expect(roll.unpriced_acts).toBe(1);
    expect(roll.has_unpriced_spend).toBe(true); // total is a FLOOR
  });

  it('period rollup honors a time window', () => {
    setModelPrice(db, 'priced', { inPerMtok: 1000, outPerMtok: 0 });
    llmSpan('priced', 'p', 1_000_000, 0, null); // $1000, "now"
    const future = new Date(Date.now() + 60_000).toISOString();
    const rollFuture = getPeriodCostRollup(db, { sinceIso: future });
    expect(rollFuture.total_cost_usd).toBe(0); // nothing after the window start
    const rollAll = getPeriodCostRollup(db);
    expect(rollAll.total_cost_usd).toBeCloseTo(1000, 3);
  });
});
