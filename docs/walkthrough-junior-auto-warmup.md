# Walkthrough — Junior auto-warmup: restore auto-open behind the C3 admission gate

**Branch:** `wt/junior-auto-warmup` · **Date:** 2026-09-08 · **Plan:**
`docs/plan-junior-auto-warmup.md` (rev 2 — senior round-1 REVISE folded: R1, R2, Rec3–Rec5)
· **Mutations:** M-AW1…7 in `docs/mutation-evidence-phase8.md`.

## The problem (verified regression)

C3 (`b671157`, 2026-09-07) put a probe-only health gate at admission. The probe
(`probeJuniorCdpHealth`) never launches, and the flow that used to launch a cold junior
(`ensureJuniorRunning`, at dispatch) is only reached *after* admission — so a cold junior
failed the probe, entered cooldown, and the department wedged: tasks queued forever, the only
unwedge a manual `run_junior`. The gate cannot distinguish "broken" from "not started yet".

## What was built

**Launch off the poll loop; probe stays the gate.**

- **`engine/flow/junior-warmer.ts` (NEW, ~200 lines)** — `JuniorWarmer`: fire-and-forget,
  deduped (one attempt per junior at a time), 60s failure backoff, 180s absolute cap whose
  cleanup lives on the `Promise.race` chain (a hung ensure cannot pin the entry — Rec4).
  Warm sequence: `ensureJuniorRunning` **without `db`** (§4.2 — no early cooldown clear), then
  a readiness loop polling **the admission probe itself** (`probeJuniorHealth` — R1: "warm
  succeeded" ⇔ "the gate passes"), then one explicit `clearJuniorUnhealthy`. Failure →
  `guardrail` span `junior_warmup_failed` + cooldown + backoff (the C3 loud path continues).
  The warmer deliberately does NOT gate on `isJuniorHealthy` — that would deadlock on the
  cooldown the sweep just set (§4.1; mutation M-AW2).
- **`engine/flow/reconcile.ts`** — `requestWarmup` hook (default no-op → every existing test
  untouched, nothing launches from unit tests), called after the existing cooldown-mark on
  probe failure; **quiet rule (R2)**: while every probe-failed junior is warming, a
  `system` span `queue_probe_warming` replaces `queue_probe_roster_exhausted` + the operator
  page (a healthy >60s cold start no longer cries "stalled" 1–3 times); mixed rosters stay
  loud with a `warming: [...]` detail.
- **`runner/main.ts`** — Runner owns a warmer (injectable for tests); `start()` fires a
  **demand-gated boot warm** (Rec3): only when ≥1 queued unassigned task exists, for the whole
  roster (A + B). An operator opening the console to an empty queue spawns no IDEs.
- **`scripts/junior_warmup.ts` + `npm run junior:warmup -- off|on|status`** (Rec5) — the
  operator keep-juniors-down switch (`bureau_meta['junior_warmup:disabled']`), journaled as a
  human act, documented in `docs/antigravity-integration.md`.

C3 invariants preserved: admission still requires a passing CDP handshake; wedged juniors
still fail closed loudly (once their warm has failed); the probe seam, the DEAD-cycle skip
order (senior note #1), and all four reconcile-touching test files behave unchanged.

## Verification (re-runnable)

- **Targeted:** `npx vitest run test/unit/junior_warmer.test.ts test/unit/reconcile.test.ts
  test/integration/tc_junior_health_admission.test.ts` → **32/32 green** (re-verified after
  the final mutation restore).
- **Full suite on the branch — 5 runs:** 908/908 green (runs 1 and 3); 907/908 with only
  `tc_primary_contamination_guard` C4 (runs 4 and 5 — the ledger-known N16 parallel-load
  flake; **13/13 green in isolation**, and that file never touches the Runner); run 2 =
  906/908 with the two failure names lost to a truncated log capture (disclosed — three
  fully-green runs bracket it, and no failure in any run named a file this stream touches).
- **`tsc --noEmit` clean** on the branch.
- **Mutations M-AW1…7:** each reproduced → caught by its named test → restored → re-verified
  green, in one sitting; records in `docs/mutation-evidence-phase8.md`.
- **CLI smoke (temp DB, never the live one):** `status` (enabled) → `off` (DISABLED,
  journaled) → `status` → `on` → bad arg prints usage and exits 1.
- **No test launches a real app or touches the live db**: warmer deps and the reconcile hook
  are injected everywhere; the runner boot-wiring test uses a dead-cycle task so even the
  live loop cannot probe real junior ports (C3 senior note #1's skip).

## What this changes operationally

After merge + console/runner restart: with queued work waiting, boot warm brings A (9333) and
B (9334) up in the background; a junior that dies with work waiting reopens via the
probe-fail trigger (≈60s backoff pacing); mid-run crashes remain the dispatch's own wedge
recovery (unchanged). The operator is paged only when a junior is genuinely stuck. Keep
juniors down deliberately with `npm run junior:warmup -- off`.
