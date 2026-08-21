# Mutation Evidence — Phase 7 (flow integration stream)

Stream: **Flow integration** (`wt/junior-a-flow-integration`) — integrating the
live harnesses (Antigravity juniors, Claude/ZCode seniors, adaptive wait) into
the jobs machinery: guards, ceilings, continuation, and verdict integrity.

Every mutation below was REALLY executed: the code was mutated, the named test
was run and observed to FAIL, the code was restored, and the test re-run green.
The reviewing Senior is expected to re-run representatives independently.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-F1 | `plan_rounds` ceiling entry-guard in `runPlanReviewCycle` | Guard condition replaced with `if (false && task.plan_rounds >= ceiling)` — an over-ceiling task proceeds to the junior | `tc_plan_cycle.test.ts` — "CEILING entry-guard: … REFUSES — guardrail span, task blocked, no junior invoked" | 1 failed / 8 passed |
| M-F2 | Fail-closed verdict parsing (`parseVerdict`) | Reintroduced the old approve-by-heuristic fallback line (`/\b(approve[d]?\|lgtm\|looks good\|ship it)\b/` → approve) | `tc_senior.test.ts` — "NEVER approves without an explicit VERDICT marker — approval-sounding prose still revises" | 1 failed / 13 passed |
| M-F3 | Stall/abort must not become a verdict (`ensureCompleted`) | Inserted `if (true) return;` so every non-completed wait is silently accepted | `tc_agent_wait.test.ts` — "throws on stalled / timeout / aborted, naming the agent and the reason" | 1 failed / 6 passed |
| M-F4 | Approve → pipeline continuation (dispatch enqueue) | `return enqueueJob(...)` guarded with `if (false)` — an approved plan records its review but never dispatches | `tc_plan_cycle.test.ts` — "APPROVE: records plan + review rows, and CONTINUES the pipeline — dispatch row + junior.dispatch job with the approved plan" | 1 failed / 8 passed |

Restoration verified after each mutation: the affected file's suite re-ran
green (full suite 281/281 twice on the branch tip, build clean — see the
walkthrough in `docs/reviews/walkthrough-flow-integration.md`).

---

## Stream A addendum — Multi-key Google provider (`wt/junior-a-google-provider`)

Multi-key Google Gemini provider with rate-limit steering, replacing the
un-provisioned Ollama officer backend. Every mutation below was really executed:
mutated, the named test observed FAILING, restored, re-run green.

| Id | Guard | Mutation applied | Test that caught it | Observed |
|---|---|---|---|---|
| M-G1 | Key hygiene — llm/guardrail spans carry the `gkey-N` slot label, never the key (`call_model.ts` serving attribution) | `servingAccount` set to `attempt.key` (the raw key) instead of `googleKeyAccount(keyIndex)` | `tc_google_provider.test.ts` — "never writes key material to the journal — only the gkey-N slot label" | 3 failed / 6 passed |
| M-G2 | Proactive RPD steering — a key slot at its daily cap is skipped (`eligibleGoogleKeyPairs`) | Dropped the `u.rpd >= limit.rpd` term from the eligibility filter | `tc_google_provider.test.ts` — "proactively skips a key slot at its daily cap (RPD steering)" | 1 failed / 8 passed |
| M-G3 | Human verify-confirm gate on filing (carried from intake stream) | see `docs/mutation-evidence-console.md` M-INTAKE-1/2 | — | — |

Settings key-entry hygiene (`POST /api/settings/google-keys`) is covered by
`tc5_settings_keys_api.test.ts`: keys never appear in `bureau_journal`,
`bureau_meta`, `bureau_models`, or `bureau_assignments`; the update span records
`{ count }` only. Restoration verified: full suite 300/300, build clean.
