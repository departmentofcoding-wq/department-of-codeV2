# Senior verdict — A2 (attribution fix, budget-refusal proof, sandbox-remote delivery)

**Senior:** claude (Claude CLI, headless) · **Branch:** wt/a2-phase7-leftovers · **Verdict:** APPROVE

Senior traced the runtime paths (not just the diff):
- **Attribution fix real & complete:** seed now uses clean `qwen2.5-coder`;
  `normalizeModelIds` runs in `applyBootMigrations` BEFORE the seeds
  (`connection.ts:34` → `adapter.ts:100`); `seedPhase1OfficerRoster` is
  meta-guarded so a healed legacy DB never re-seeds the prefixed id (no race).
  The rename is FK-safe (insert clean row + repoint assignment before dropping
  the old row, in its own transaction). Note: `test/unit/llm_b1_b2.test.ts:79`
  has a literal `ollama/qwen2.5-coder`, but it's a journal fixture value, not a
  registry lookup — harmless.
- **Budget-refusal proof legitimate:** guard at `call_model.ts:214-221`; the
  token-ceiling math checks out (ceiling 120, turn 1 spends 150 → turn 2 refused
  pre-call). The mutation disables both ceilings → 4/4 fail. Real pre-call test.
- **C1 sandbox test genuine:** real `git init --bare` remote; the mismatch case
  swaps in a no-op push while local/remote tips stay real — proving the readback
  guardrail + `BackupPushError` fire.

**Process note (addressed at merge):** the two-dot review diff showed A1's files
as deleted (stale-base artifact — A2 was cut before A1 merged); a real three-way
`git merge` retains A1 untouched. The only real conflict was
`docs/mutation-evidence-phase7.md` (both streams appended) — resolved by keeping
both addenda. Full suite re-run fresh post-merge to confirm A1+A2 coexist green.
