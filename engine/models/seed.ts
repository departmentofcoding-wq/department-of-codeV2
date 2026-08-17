import type { DbConnection } from '../contract/index.ts';
import { registerModel, assignRole } from './registry.ts';

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
