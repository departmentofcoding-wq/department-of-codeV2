import type { DbConnection } from '../contract/index.ts';
import { registerModel, assignRole } from './registry.ts';
import { hasGoogleKeys } from '../llm/google_keys.ts';

export function seedModelsAndAssignments(db: DbConnection): void {
  // Seed GLM-5.2 (Senior Engineer model)
  registerModel(db, {
    id: 'glm-5.2',
    provider: 'zai',
    display: 'GLM 5.2 (ZCode)',
    price_in_usd_per_mtok: null, // Unpriced (never 0)
    price_out_usd_per_mtok: null,
    enabled: 1,
    notes: 'Primary Senior Engineer model via Z.ai/ZCode'
  });

  // Seed placeholder Antigravity models (Junior Engineer models)
  registerModel(db, {
    id: 'gemini-3.6-flash',
    provider: 'antigravity',
    display: 'Gemini 3.6 Flash (Free)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled: 1,
    notes: 'Antigravity free-tier model'
  });

  registerModel(db, {
    id: 'gemini-3.1-pro',
    provider: 'antigravity',
    display: 'Gemini 3.1 Pro (Free)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled: 0,
    notes: 'Antigravity free-tier model; seeded disabled — v1 measured 0 requests/day on the free tier'
  });

  // Seed Role Assignments
  assignRole(db, 'senior-engineer', 'zcode', 'glm-5.2');
  assignRole(db, 'junior-engineer', 'antigravity-cdp', 'gemini-3.6-flash');
}

export function seedPhase1OfficerRoster(db: DbConnection): void {
  const check = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', 'seed:phase1-officer-roster');
  if (check && check.value === 'done') {
    return;
  }

  registerModel(db, {
    id: 'gemini-2.5-flash',
    provider: 'google',
    display: 'Gemini 2.5 Flash (Free)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled: process.env.GOOGLE_API_KEY ? 1 : 0,
    notes: 'Google Gemini free-tier model'
  });

  registerModel(db, {
    id: 'ollama/qwen2.5-coder',
    provider: 'ollama',
    display: 'Qwen 2.5 Coder (Ollama)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled: 1,
    notes: 'Local Ollama instruct model'
  });

  assignRole(db, 'task-intake-officer', 'ollama', 'ollama/qwen2.5-coder');

  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    'seed:phase1-officer-roster',
    'done'
  );
}

/**
 * Versioned reseed (v2): move the Google-eligible roles off the un-provisioned
 * local/free backends and onto Google Gemini free-tier models, ordered by the
 * operator's real per-key rate limits (flash-lites are the 500/day workhorses).
 *
 * Runs on every boot but is meta-guarded so it applies exactly once per DB —
 * critically, this is what reaches the *existing* live db/bureau.db, whose
 * models table is non-empty and so never re-runs the first-boot seed.
 *
 * The senior-engineer (Z.ai / Claude, harness-driven) is deliberately NOT
 * touched: it is never a callModel google candidate.
 */
/**
 * Register the Google roster models (at the given enabled state) and point the
 * Google-eligible roles at them. Idempotent; not meta-guarded — call it whenever
 * key availability changes (e.g. the operator saves keys in Settings).
 */
export function applyGoogleRoster(db: DbConnection, enabled: number): void {
  // Workhorses: 500 RPD / 15 RPM each (×2 keys ≈ 1000 RPD, 30 RPM per model).
  registerModel(db, {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    display: 'Gemini 3.1 Flash Lite (Free)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled,
    notes: 'Google free tier — 500 RPD / 15 RPM / 250K TPM per key (intake-officer primary)'
  });
  registerModel(db, {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    display: 'Gemini 3.5 Flash Lite (Free)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled,
    notes: 'Google free tier — 500 RPD / 15 RPM / 250K TPM per key (junior primary)'
  });
  // Higher-quality but scarce (20 RPD): spill-over only.
  registerModel(db, {
    id: 'gemini-3.6-flash',
    provider: 'google',
    display: 'Gemini 3.6 Flash (Free)',
    price_in_usd_per_mtok: null,
    price_out_usd_per_mtok: null,
    enabled,
    notes: 'Google free tier — 20 RPD / 5 RPM / 250K TPM per key (quality spill-over)'
  });

  // Google powers the high-volume "doing" roles; the senior stays put.
  assignRole(db, 'task-intake-officer', 'google', 'gemini-3.1-flash-lite');
  assignRole(db, 'junior-engineer', 'google', 'gemini-3.5-flash-lite');
}

export function seedGoogleRosterV2(db: DbConnection): void {
  const check = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', 'seed:google-roster-v2');
  if (check && check.value === 'done') {
    return;
  }

  applyGoogleRoster(db, hasGoogleKeys() ? 1 : 0);

  db.run(
    `INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    'seed:google-roster-v2',
    'done'
  );
}
