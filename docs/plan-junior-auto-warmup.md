# Plan — Junior auto-warmup: restore auto-open behind the C3 admission gate

**Status:** proposed, **revision 2** (2026-09-08) — senior round-1 verdict **REVISE** folded in
(R1, R2 required; Rec3–Rec5 + nits accepted). Awaiting re-confirmation; nothing implemented.
· **Stream (when approved):** `wt/junior-auto-warmup`, cut from main tip (`8482c2f`).
**Author:** operator-side ZCode session (engine-dev). **Reviewer:** senior, per dept law.

Bootstrap this session: suite **888/889** (one failure = `t5_two_runners`, passes 2/2 in
isolation — same parallel-load flake class as `t4`/`tc_primary_contamination_guard`; candidate
for the ledger's known-flake list), `tsc --noEmit` clean.

### Round-1 disposition map

| Senior finding | Disposition |
|---|---|
| R1 — warmer's success criterion ≠ probe's criterion | §3.1.5b now waits for **probe readiness** (`probeJuniorHealth` loop), M-AW3 re-pointed |
| R2 — operator paged during healthy warm | §3.2 quiet rule (`queue_probe_warming` span, notify only when genuinely stuck), M-AW7 added |
| Rec3 — gate boot-warm on demand | §3.3 (senior's selected default) |
| Rec4 — cap cleanup on the race chain | §3.1.6 + M-AW6 |
| Rec5 — specify the `junior_warmup:disabled` setter | §3.4 |
| Nits | `junior_warmup_failed` → `guardrail` kind (§3.1.5d); `test/unit/tc_junior_health_probe.test.ts` in the verification list (§6); t5 ledger note at delivery |

---

## 1. Problem

**The department no longer opens a cold Antigravity junior by itself.** Filed tasks sit
`queued` forever when both juniors are down: the admission gate probes, the probe fails on a
not-yet-launched junior, the junior enters cooldown, and the flow never reaches the dispatch
step that used to launch the IDE. The only unwedge today is the operator manually running
`run_junior`. The 2026-09-07 ledger names junior reliability as the department's #1 bottleneck;
this is the engine-side half of it.

### Root cause — a C3 regression (confirmed)

Before C3, a cold junior was launched at **dispatch** time: admission → assign + enqueue
`plan.cycle` → junior dispatch → seam `runCommand` → **`ensureJuniorRunning`**
([antigravity.ts:319](../engine/harness/antigravity.ts)) → "see if this junior is open, or open
it".

C3 (merge `b671157`, 2026-09-07) inserted a **probe-only** health gate *ahead* of that step:
`reconcileQueuedTasks` Stage 3 calls `probeJuniorHealth` → `probeJuniorCdpHealth`
([antigravity.ts:491](../engine/harness/antigravity.ts)) which only checks
`findMainWindowWs(port)` + a `Runtime.evaluate` round-trip — **it never launches**. A merely
cold junior fails the probe → `setJuniorUnhealthy` (60s cooldown) → `break` — the sweep halts
before any code path that would open the IDE. The gate cannot distinguish "broken" from "not
started yet". (C3's verdict — `docs/reviews/verdict-c3-junior-health-gate.md` — was reviewed
against *wedged* juniors; the *cold*-junior case was not in evidence that round.)

C3's intent is right and stays: **never dispatch onto an unproven junior.** What is missing is
a *producer* that makes the gate pass for a healthy-but-closed junior.

## 2. Design in one line

**Launch off the poll loop; probe stays the gate.** A background, deduped, backoff-paced
**junior warmer** opens cold juniors (demand-gated at boot + on admission-probe-failure);
admission remains a fast fail-closed CDP probe that holds until the junior is genuinely up —
then admits.

### Why not ensure-then-probe inline in the sweep (the earlier draft's option B)

`reconcileQueuedTasks` is `await`ed **inside the runner's 100ms poll loop**
([runner/main.ts:218](../runner/main.ts)); `ensureJuniorRunning` can block up to
`JUNIOR_PORT_WAIT_MS = 90s` per cold junior ([antigravity.ts:312](../engine/harness/antigravity.ts))
— up to ~180s for the roster. During that block the same loop does no job claiming, no
lease reaping/watchdog, no delivery re-drive (`reconcileDeliveries`, reaper and watchdog all
live in `loop()`). The lease reaper's recovery contract is built on ~30s responsiveness
(`BUREAU_LEASE_MS`). An inline launch freezes the department's own maintenance for minutes.
Rejected.

## 3. Components

### 3.1 NEW `engine/flow/junior-warmer.ts` — the warm-up owner

```ts
export interface JuniorWarmerDeps {
  ensure?: typeof ensureJuniorRunning;                    // default: real, called WITHOUT db
  probe?: (cfg: JuniorConfig) => Promise<boolean>;        // default: probeJuniorHealth (the seam) — R1
  now?: () => number;                                    // test clock
}
export class JuniorWarmer {
  constructor(db: DbConnection, deps?: JuniorWarmerDeps);
  /** Fire-and-forget. Returns true iff a warm for this junior is IN FLIGHT after
   *  the call (newly started, already in flight). False: backoff-blocked or disabled. */
  request(juniorId: string, reason: 'boot' | 'probe_failed'): boolean;
  isInFlight(juniorId: string): boolean;                 // test/introspection only
}
```

`request(j)` runs entirely in the background (a per-junior in-flight `Promise`), and:

1. **Disabled switch:** if `bureau_meta['junior_warmup:disabled']` is truthy → return `false`
   (the operator's keep-juniors-down switch — see §3.4).
2. **Dedupe:** if a warm is already in flight for `j` → return `true`. One launch attempt at a
   time per junior — the 100ms sweep can fire `request` every tick without spamming launches.
3. **Failure backoff (warmer-owned, in-memory):** if the last attempt for `j` FAILED and
   < `WARM_RETRY_BACKOFF_MS` (60s) ago → return `false`. This — not `isJuniorHealthy` — is the
   retry pacing. See §4.1 for why the gate must NOT be the meta cooldown.
4. Journal a `system` span `junior_warmup_requested {junior, reason}` (deterministic
   `queue-policy` attribution, matching the reconcile acts).
5. **Warm sequence** (all inside the in-flight promise):
   a. `ensureJuniorRunning(cfg, {})` — **without `db`** (§4.2). Reuses a live port fast
      (single `isDebugPortLive` check); else spawns with the per-junior debug port +
      `--user-data-dir` and waits ≤ 90s for the port.
   b. **Probe-readiness loop (R1):** poll `probeJuniorHealth(cfg)` — the *same* check the
      admission gate uses, i.e. `findMainWindowWs` **and** the `Runtime.evaluate('1+1')===2`
      handshake — every ~2s (each attempt carries the probe's own 2.5s
      `JUNIOR_HEALTH_PROBE_TIMEOUT_MS`) until true, budget `MAIN_WINDOW_ATTACH_MS` (60s) after
      port-live. Waiting merely for the window ws is NOT sufficient and is no longer claimed:
      the page target can exist before the renderer answers `Runtime.evaluate`, so
      window-presence does not imply gate-pass. **"Warm succeeded" now means exactly "the C3
      probe passes."** A warm that never reaches probe-readiness inside the budget is a
      FAILURE (5d), not a success.
   c. Success → `clearJuniorUnhealthy(db, j)` + journal `system` span
      `junior_warmup_succeeded {junior, launched}`. The next 100ms sweep sees no cooldown,
      probes, passes, admits.
   d. Failure (absent binary, port timeout, probe-readiness timeout, or the absolute cap) →
      journal a **`guardrail`** span `junior_warmup_failed {junior, error}` (the
      health-degradation family, matching `junior_unhealthy_hold`) +
      `setJuniorUnhealthy(db, j, 60s, 'warmup_failed')` + record backoff timestamp.
      Genuinely broken juniors keep the existing C3 loud path (§3.2). An absent install never
      thrashes: backoff + cooldown pace it, the error text says what to fix.
6. **Absolute cap** `WARM_ABSOLUTE_CAP_MS = 180s` (90 port + 60 readiness + slack) via
   `Promise.race`, and — **Rec4** — the in-flight map entry is deleted in the `.finally` of
   the **race chain, not the inner ensure**, so a hung `ensure`/probe call cannot pin the
   entry and defeat the cap:

   ```ts
   const attempt = this.runWarmSequence(j);          // never rejects — failures become results
   const raced = Promise.race([attempt, capRejection(WARM_ABSOLUTE_CAP_MS)]);
   this.inFlight.set(j, raced);
   raced.finally(() => this.inFlight.delete(j))      // cleanup on the RACE (Rec4)
        .catch(() => {});                            // the cap's rejection is a result, not a crash
   ```

   A capped attempt counts as failure (5d → guardrail span, cooldown, backoff).

Worst-case cold-start-to-admission ≈ 40–150s — identical to what pre-C3 dispatch spent in
`ensureJuniorRunning` + attach. No latency regression vs the pre-C3 world; strictly better
than today's wedge (never admits).

### 3.2 `engine/flow/reconcile.ts` — one hook, C3 semantics untouched, honest paging (R2)

- `ReconcileOptions` gains
  `requestWarmup?: (juniorId: string) => boolean | void` — **default no-op (returns
  undefined)**. Return value: `true` iff a warm for that junior is in flight after the call.
- In the Stage-3 probe-fail branch, after the existing `setJuniorUnhealthy` + guardrail
  journal: `const warming = opts.requestWarmup?.(j) === true` — fire-and-forget, never
  awaited. Track the per-junior result across the candidate loop.
- **Quiet rule (R2):** `notifyOperator` is a bare, undeduped WARN
  ([notifications.ts:9](../engine/state/notifications.ts)), and a legitimate warm can span
  2–3 cooldown windows — so paging on every window's roster exhaustion would cry "stalled"
  1–3 times during a *healthy* auto-warm. Therefore, in the no-junior-admitted block:
  - If **every** junior that probe-failed this sweep reports a warm in flight → write a quiet
    `system` span `queue_probe_warming {freeRoster, warming: [...]}` and **do not** write
    `queue_probe_roster_exhausted` / notify the operator. (Naturally throttled to once per
    cooldown window by the existing cooldown skip.)
  - Otherwise (some probe-failed junior has **no** warm in flight — warm failed into backoff,
    cap tripped, or warming disabled) → the existing loud path fires **unchanged**
    (`queue_probe_roster_exhausted` guardrail span + operator notify), with the span detail
    gaining a `warming: [...]` list when the split is mixed.
- Everything else stays exactly as C3 + senior note #1 built it: the probe seam (`opts.probe`),
  the DEAD-cycle skip order, the predicate, cooldown marking (it throttles re-probing —
  without it every 100ms tick would re-probe a cold junior).

Default-no-op is load-bearing: every existing reconcile/queue test (`test/unit/reconcile.test.ts`,
`tc_flow_assignment_queue`, `tc_junior_health_admission`, `tc_journal_completeness`) exercises
probe failures and must not spawn a real IDE — the tests never touch the network or launch
apps. With the default hook the quiet rule never engages (no-op returns falsy → loud path),
so existing span/notify assertions are unaffected. Production wiring happens only where the
Runner is constructed.

### 3.3 `runner/main.ts` — wiring (covers both executors)

The console embeds the single Runner (`scripts/console.ts:238`), so Runner-level wiring
reaches every production path:

- Constructor options gain `{ warmer?: JuniorWarmer }` (tests inject a fake; default =
  `new JuniorWarmer(this.db)`), mirroring the existing notifier injection.
- `start()` — **Rec3 (senior's selected default): demand-gated boot warm.** Only if the queue
  holds demand (`SELECT COUNT(*) FROM bureau_tasks WHERE state='queued' AND archived_at IS
  NULL AND assigned_junior IS NULL` > 0) fire `warmer.request(j, 'boot')` for every roster
  junior (A:9333 + B:9334) — fire-and-forget, best-effort, wrapped so a warmer throw can never
  fail boot. An operator who opens the console to an empty queue gets no IDEs spawned; the
  department's own principle ("a junior closed with an empty queue stays closed") extends to
  boot. A task filed later cold-starts through the `probe_failed` trigger — the same latency
  class as pre-C3 dispatch, which launched lazily at first dispatch anyway.
- **No blind periodic roster re-warm.** Demand is edge-triggered by the admission gate itself:
  a queued candidate + cold junior → probe fail → `requestWarmup('probe_failed')`, retrying
  every cooldown/backoff window (~60s) until it succeeds or stays loud. A junior that dies
  **mid-run** remains the dispatch's own business (`recoverJuniorRunning` /
  `isJuniorWedgedWindowError` — WS2/F3, unchanged). A junior the operator closes with an
  empty queue stays closed; with work waiting it reopens — that is the department working as
  intended, and `junior_warmup:disabled` (§3.4) is the opt-out.

### 3.4 The operator switch — `junior_warmup:disabled` (Rec5)

Because the warmer ignores the meta cooldown (§4.1), a manually-set cooldown no longer pins a
junior down while demand exists — so the switch needs its own first-class door:

- NEW `scripts/junior_warmup.ts` + `npm run junior:warmup -- off|on|status` — reads/upserts/
  deletes the `bureau_meta['junior_warmup:disabled']` key, journals a `human` span (operator
  attribution) on every set/clear. `status` prints the key + per-junior live-warm state.
- Documented in `docs/antigravity-integration.md` alongside the manual `run_junior` recovery
  (which remains the force-open path when warming is disabled).

## 4. Two subtle interactions (the parts most likely to be designed wrong)

### 4.1 The warmer must NOT gate on `isJuniorHealthy` — the self-deadlock

The admission probe-fail path **itself marks the 60s meta cooldown**. If the warmer refused to
run for cooling juniors, the cooldown just set by the sweep would block the very warm-up the
probe failure requested → permanent wedge (exactly today's behavior). Therefore the warmer's
gates are its own in-flight map + failure backoff; the meta cooldown remains purely the
sweep's re-probe throttle, cleared once by warm success. Consequence (disclosed): a manually
set meta cooldown no longer pins a junior down while demand exists — the operator switch is
`junior_warmup:disabled` (§3.4). Rejected alternative: reconcile skipping the cooldown mark
when a hook is wired — couples the layers and changes C3-tested behavior.

### 4.2 Call `ensureJuniorRunning` WITHOUT `db`, clear the cooldown once at the end — and never page during a healthy warm

`ensureJuniorRunning` clears the meta cooldown itself the moment the **port** answers
([antigravity.ts:341](../engine/harness/antigravity.ts)). The port beats probe-readiness by a
wide margin; an early clear would let the sweep re-probe mid-warm, re-fail, re-mark cooldown —
noise, and a second `requestWarmup` (deduped, but still). With no-db + one explicit
`clearJuniorUnhealthy` after the **probe-readiness** loop, the sweep holds quietly at Stage 2
(cooldown) for the whole warm.

Corrected cadence math (rev 1 wrongly claimed "exactly one WARN"): a cold start legitimately
spans multiple 60s cooldown windows (90s port + up to 60s readiness), and each window-expiry
sweep re-probes, re-fails, and — pre-R2 — re-fired the roster-exhausted notify: **1–3 false
"Queue may be stalled" pages per healthy warm.** The §3.2 quiet rule replaces that: warming
windows journal `queue_probe_warming` spans only; the operator notify fires **only when a
probe-failed junior has no warm in flight** (warm failed into backoff, cap tripped, or
warming disabled) — i.e. when it is genuinely stuck. (If warm succeeded but the probe still
fails — readiness beyond budget — the next request restarts cleanly since the prior attempt
succeeded: no backoff; bounded by the readiness reality, and loud if it keeps failing.)

### 4.3 Single-executor assumption

Warmer state is per-Runner-instance. The single-executor model says one Runner exists; if two
ever run concurrently, both may attempt a warm — `ensureJuniorRunning` is safe under this
(Electron single-instance lock absorbs the duplicate spawn; the loser's port-wait observes the
winner's port). Disclosed, not defended further.

## 5. C3's invariants — explicitly preserved

- Admission still requires a **passing CDP handshake probe**; nothing dispatches onto an
  unproven junior. Cold juniors are *made provable*; broken juniors still fail closed.
- Wedge protection intact: a port-open-but-GUI-dead junior still probes false, still cools
  down, still reaches the loud roster-exhausted path once warming has failed for it.
- The probe test seam (`opts.probe`) and all four reconcile-touching test files unchanged in
  behavior (the new hook defaults to no-op; the quiet rule cannot engage without it).
- Senior note #1 (DEAD-cycle skip above the probe) untouched.
- **New (R2):** the operator is paged about queue-probe exhaustion only when a probe-failed
  junior has no warm in flight — never during a healthy warm.

## 6. Tests + mutation evidence (per dept law)

**New `test/unit/junior_warmer.test.ts`** (fake `ensure`/`probe`/clock; no real launches):
dedupe (one ensure per in-flight window; second `request` returns true); success = probe says
ready → clears cooldown + journals requested/succeeded; readiness-timeout (probe never true
within budget) → **failure** path (guardrail span + cooldown + backoff); failure → backoff
blocks an immediate re-request (returns false) and allows it after the window (fake clock);
disabled meta key → no ensure, returns false; **absolute cap (Rec4):** a hung `ensure` → the
in-flight map is EMPTY after the cap and a new request can start a fresh warm; port-already-live
(`launched:false`) still runs the readiness loop.

**Extend `test/unit/reconcile.test.ts`:** probe-fail invokes `requestWarmup` once per probed
junior; default no-op (no hook → no throw, loud path unchanged); **the un-wedge integration
case** — probe fake fails while "cold", the fake warmer (wired through the hook) flips the
probe to pass and clears cooldown, second `reconcileQueuedTasks` sweep admits the task; **the
quiet rule** — probe-fail with the hook returning `true` writes `queue_probe_warming` and NOT
`queue_probe_roster_exhausted`; hook returning `false` (warm failed) keeps the loud span.

**Extend `test/integration/tc_junior_health_admission.test.ts`:** the cold→warm→admit flow
end-to-end with fakes; cooldown/journal assertions unchanged for the plain-failure path.

**Runner wiring test:** `start()` with a fake warmer — queue empty → **no** boot requests
(Rec3); one queued task → boot requests for A and B, non-blocking; options-injection path used
(no real warmer).

**Verification list includes `test/unit/tc_junior_health_probe.test.ts`** (nit): the warmer's
readiness loop reuses `probeJuniorHealth`, so its existing probe-semantics tests must stay
green untouched.

**Mutations (`docs/mutation-evidence-phase8.md`):**
- M-AW1: delete the `requestWarmup` call in the probe-fail branch → un-wedge test fails
  (task never admitted) — the core regression guard.
- M-AW2: gate the warmer on `isJuniorHealthy` (the §4.1 trap) → un-wedge test fails exactly
  like today's wedge.
- M-AW3 (**re-pointed, R1**): return success at window-presence instead of probe-readiness →
  "warm success ⟹ probe passes next sweep" test fails.
- M-AW4: remove dedupe → concurrent-ensure test fails.
- M-AW5: remove backoff → immediate-re-request after failure test fails.
- M-AW6 (**new, Rec4**): move the in-flight cleanup off the race chain (cleanup only in the
  inner sequence) → hung-ensure test fails (map stuck after cap).
- M-AW7 (**new, R2**): remove the quiet rule (always loud on roster exhaustion) → the
  "warming writes `queue_probe_warming`, not `queue_probe_roster_exhausted`" test fails.

Suite ×2 + `tsc --noEmit` per convention; no test touches the network or the live db.

## 7. Files

| File | Change |
|---|---|
| `engine/flow/junior-warmer.ts` | NEW — warmer (≈130 lines) |
| `engine/flow/reconcile.ts` | +`requestWarmup` hook (no-op default), quiet rule, 1 call site |
| `runner/main.ts` | warmer option + demand-gated boot warm (≈30 lines) |
| `scripts/junior_warmup.ts` + `package.json` | NEW — the operator switch CLI (Rec5) |
| `test/unit/junior_warmer.test.ts` | NEW |
| `test/unit/reconcile.test.ts`, `test/integration/tc_junior_health_admission.test.ts` | extend |
| `docs/mutation-evidence-phase8.md` | M-AW1…7 |
| `docs/antigravity-integration.md` | warm-up section + the `junior_warmup:disabled` switch + CLI |
| `docs/walkthrough-junior-auto-warmup.md` | at delivery |

Disjoint from the three console tasks in flight — safe as a parallel stream.

## 8. Settled questions (previously open; round-1 adjustments noted)

1. **Approach** — background warm-up (this plan) vs. minimal bounded ensure-then-probe inline.
   Inline rejected on poll-loop math (§2). **Settled: background.**
2. **Re-warm cadence** — no blind timer. **Demand-gated boot warm (Rec3, senior-selected)** +
   edge-triggered on probe failure, paced by 60s backoff; mid-run deaths stay with dispatch
   recovery. **Settled: demand-driven.**
3. **Scope** — juniors only. Senior drivers already self-heal (WS1 `ensureSeniorRunning` +
   `runSeniorWithRecovery` for zai; claude is a headless subprocess — nothing to pre-warm).
   **Settled: A + B only.**
4. **Delivery** — this cannot ride the queue (the queue is what's wedged). Engine-dev on
   `wt/junior-auto-warmup` (C-series precedent), senior verdict at the exact hash, operator
   merges through the tracked path, then restart the console/runner: **boot warm-up (with
   queued demand) un-wedges the department with no manual `run_junior`**. **Settled:
   engine-dev stream.**

## 9. Out of scope

Senior-driver warming (WS1 covers it); junior B's standing CDP flakiness beyond warm-up (the
separate junior-reliability stream); any selector recalibration; a mid-run liveness watchdog
for occupied juniors (dispatch recovery owns that); changes to the probe itself.
