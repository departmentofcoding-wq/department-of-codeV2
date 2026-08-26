import type { DbConnection } from '../contract/index.ts';

/**
 * Per-model pricing for the cost ledger (A5).
 *
 * Price lives in two places, checked in order:
 *   1. `bureau_meta` keys `price:<model>:in_usd_per_mtok` / `:out_usd_per_mtok`
 *      — operator-updatable at runtime without touching model rows.
 *   2. the `bureau_models` row's `price_in_usd_per_mtok` / `price_out_usd_per_mtok`
 *      columns — the static default.
 *
 * A model with NO price in either place is **unpriced**: its token spend is real
 * but its dollar cost is unknown, which is NOT the same as $0. The ledger keeps
 * that distinction (the honesty flag), so an unpriced model never silently reads
 * as free. A model priced at 0 (e.g. a genuinely free local model) is priced —
 * that is a real $0, recorded as such.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inPerMtok: number;
  /** USD per 1M output tokens. */
  outPerMtok: number;
}

const META_IN = (model: string) => `price:${model}:in_usd_per_mtok`;
const META_OUT = (model: string) => `price:${model}:out_usd_per_mtok`;

function metaNum(db: DbConnection, key: string): number | null {
  const row = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', key);
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/** Resolve a model's price, or null when it is unpriced in both sources. */
export function getModelPrice(db: DbConnection, model: string): ModelPrice | null {
  const metaIn = metaNum(db, META_IN(model));
  const metaOut = metaNum(db, META_OUT(model));
  if (metaIn !== null || metaOut !== null) {
    return { inPerMtok: metaIn ?? 0, outPerMtok: metaOut ?? 0 };
  }
  const row = db.get<{ price_in_usd_per_mtok: number | null; price_out_usd_per_mtok: number | null }>(
    'SELECT price_in_usd_per_mtok, price_out_usd_per_mtok FROM bureau_models WHERE id = ?',
    model
  );
  if (row && (row.price_in_usd_per_mtok !== null || row.price_out_usd_per_mtok !== null)) {
    return { inPerMtok: row.price_in_usd_per_mtok ?? 0, outPerMtok: row.price_out_usd_per_mtok ?? 0 };
  }
  return null;
}

/** Compute the USD cost of a token count at a given price. */
export function costOf(price: ModelPrice, tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * price.inPerMtok + (tokensOut / 1_000_000) * price.outPerMtok;
}

/**
 * Set (or update) a model's price via meta — the runtime-updatable path. Meta is
 * keyed per model, so re-pricing one model never disturbs another, and the
 * ledger picks it up on the next rollup with no restart.
 */
export function setModelPrice(db: DbConnection, model: string, price: ModelPrice): void {
  const upsert = (key: string, value: number) =>
    db.run(
      `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value)
    );
  upsert(META_IN(model), price.inPerMtok);
  upsert(META_OUT(model), price.outPerMtok);
}
