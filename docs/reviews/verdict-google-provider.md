# Senior Verdict — Phase 7 Stream A: Multi-key Google Provider

**Commit under review:** `df7f442f53c69edb1d705d9cf2d7e5dbd41978ef`
**Branch:** `wt/junior-a-google-provider` (cut from `main` at `6a111dc`, single commit)
**Scope:** Multi-key Google Gemini provider with per-pair cooldown and proactive
rate-limit steering, versioned roster reseed (officer off the un-provisioned
Ollama backend), and the Settings → Google API keys entry — per the reviewed
plan plus all eight Senior amendments.
**Date:** 2026-08-21
**Verdict:** ✅ **APPROVE — merge to main**

## What was verified (independently, not trusted)

- **Suite + build, re-run by the senior:** two full runs, both exit 0 —
  **300/300 across 76 files** (main was 288/74; +12 tests in
  `tc_google_provider` (9) + `tc5_settings_keys_api` (3)) — and `tsc --noEmit`
  clean. Matches the walkthrough claim exactly.
- **All eight review amendments present in the diff:**
  1. Versioned reseed: `seedGoogleRosterV2` with its own meta key
     (`seed:google-roster-v2`), called at boot from `openDbConnection` —
     reaches the existing live DB whose models table is non-empty.
  2. Junior reassignment honestly framed (roster/legacy-path only; the live
     junior remains the Antigravity harness — stated in the walkthrough).
  3. Multi-key checks in all three places: `getCandidateModels`,
     `GoogleClient` (caller-supplied key with env fallback), seed-time
     `enabled` gating.
  4. Steering constrained by construction: role primary first, then Google
     models ordered by daily-quota generosity (flash-lites 500 RPD before
     flash 20 RPD), Ollama last; unknown Google models get a conservative
     5/20 default.
  5. Attribution: the serving slot `gkey-N` is journaled on both the success
     span and the 429 guardrail span; the officer's stale hardcoded
     `ollama/qwen2.5-coder` fallback label is updated.
  6. Out-of-band usage blindness acknowledged (journal steering sees bureau
     traffic only; reactive 429 cooldown remains the net).
  7. Injectable `FetchLike` seam on `GoogleClient`; provider tests run fully
     offline with scripted clients and temp key files.
  8. Run as Phase 7 Stream A (branch `wt/junior-a-google-provider`, single
     stream over `engine/llm/**`) — no cross-stream collision.
- **Key hygiene (the law + T18) holds everywhere:**
  - `/secrets/` is in `.gitignore` and `git check-ignore` confirms
    `secrets/google.env` is ignored; `saveGoogleKeys` validates `AIza…`
    shape, writes env + 0600-best-effort file, never the DB.
  - GET returns masked values only; the settings-update journal span records
    `{ count }` only; refusal reasons are static strings.
  - `loadGoogleKeysFromDisk` runs in BOTH entrypoints (`runner/main.ts`,
    `scripts/console.ts` serve path) before `openDbConnection`, so saved keys
    persist across restarts and the boot seed sees them; explicit env wins
    over the file.
  - Saving keys calls `applyGoogleRoster(db, 1)` — the roster enables live,
    no restart (intake turns run in-process), so the "paste keys → file a
    task" flow works in one console session.
- **Tests are real:** scripted-client `callModel` runs assert on DB rows
  (per-pair cooldown keys `model:keyIdx`, journal account labels, whole-DB
  key-material scan — not self-filtering); settings tests use
  `BUREAU_GOOGLE_KEYS_FILE` pointed at temp dirs, restore env, and assert no
  key material lands in `bureau_journal`/`bureau_meta`/`bureau_models`/
  `bureau_assignments`. Contract updated 12 → 14 endpoints, all token-auth.
- **Mutation evidence independently reproduced:** M-G1 — setting
  `servingAccount` to the raw key instead of `googleKeyAccount(keyIndex)`
  fails exactly 3 tests, including "never writes key material to the journal"
  (the journal row verbatim contains the test key); restored, 9/9 green,
  tree clean. M-G2 (RPD steering eligibility) mapped directly to the
  `eligibleGoogleKeyPairs` filter and the RPD test assertions.

## Non-blocking notes (operator follow-ups, not merge blockers)

- Pre-migration `llm` spans carry `account: null` and therefore don't count
  against any `gkey-N` pool — per-pair accounting starts fresh from this
  merge. Correct choice, but dashboards reading per-key usage start at zero.
- The junior-engineer roster row now reads Google/3.5-flash-lite, so the
  Workers tab no longer advertises the Antigravity backend for juniors; the
  real junior is unaffected (harness-driven, model chosen in its GUI).
- First live officer turn on Gemini is still an operator activity — tests use
  fakes by law; watch for the 60s `intake.turn` timeout on a cold first call.
- `[llm]` provider-doubling (Phase 7 A2) remains open and untouched — it now
  has a clean single owner in this stream's successor.

The officer's Ollama dependency is gone from the critical path, keys stay in
env/gitignored-file only, and the confirm-verify gate is untouched. Approved
for merge.
