# Walkthrough — A2: Phase-7 leftovers (attribution, budget proof, sandbox remote)

**Branch:** `wt/a2-phase7-leftovers` (cut from `main` = `562d2a9`)
**Stream:** Part A / A2 of `docs/plan-bureau-kernel-roadmap.md`

## What this stream does

Closes A2 — the three small, known Phase-7 leftovers.

### 1. Provider-doubling attribution (`[llm]` rollups)
Root cause found: the seeded model **id** `ollama/qwen2.5-coder` embedded its own
provider. Every other model id is clean (`glm-5.2`, `gemini-3.6-flash`), so this
lone id doubled the provider in the `(provider, model)` rollup key **and** was
sent verbatim to Ollama as a malformed model name (`OllamaClient` forwards
`model.id`).
- `engine/models/seed.ts`: id + assignment → clean `qwen2.5-coder`.
- `engine/db/schema.ts`: `normalizeModelIds` in the boot door heals existing DBs
  (inserts the clean row, repoints the assignment, drops the prefixed row —
  FK-safe, idempotent). Journal history is left intact (append-only).
- `test/unit/tc_llm_attribution.test.ts` (3 tests): no seeded id embeds its
  provider; the boot door heals a legacy row; rollups group `(ollama,
  qwen2.5-coder)` with the provider appearing once.
- `engine/models/models.test.ts`: two assertions updated to the clean id.

### 2. Budget-refusal proof
The guard already lived in `callModel` (budget check FIRST). This stream adds the
missing **token-ceiling** case to `t15_budget_ceiling.test.ts` (it only covered
requests) and mutation-proves the guard.

### 3. Delivery against a real remote (C1)
`test/integration/t46_sandbox_remote.test.ts`: `backup.push` against a real
throwaway **bare** git remote, proving the anti-false-claim readback both ways —
a real push matches on readback (success span); a push that reports success
without landing is caught as a `mismatch` guardrail + `BackupPushError`.

## Claims (for independent senior verification)

1. **Suite green:** `442 tests / 96 files` pass; `npm run build` clean. (Baseline
   435/94 → +7 tests, +2 files.)
2. **M-LLM-1 (mutation):** reverting the seed to `ollama/qwen2.5-coder` fails
   `tc_llm_attribution` (2 failed / 1 passed — a seeded id embedded its
   provider); restored → 3/3.
3. **M-BUDGET-1 (mutation):** disabling the ceiling guard
   (`if (overTokenBudget || overReqBudget)` → `if (false && …)`) fails all 4
   `t15` cases (the run overspends past the ceiling, no guardrail); restored →
   4/4.
4. **Boot-door heal:** a DB seeded with the legacy prefixed id is normalized on
   next open — the prefixed row is gone, the clean row exists, and the
   `task-intake-officer` assignment is repointed. (tc_llm_attribution heal test.)
5. **C1 readback:** t46 pushes to a real bare remote; success readback matches,
   and a non-landing push is caught (`mismatch` guardrail + throw), with
   `ls-remote` confirming the remote is genuinely behind local.

## Notes
- Mutation evidence recorded in `docs/mutation-evidence-phase7.md` (M-LLM-1,
  M-BUDGET-1). This branch appends to the same file A1 does; the operator merges
  A1 first, then resolves the trivial tail append when merging A2.
- Independent of A1 (different files) — reviewable and mergeable on its own.
