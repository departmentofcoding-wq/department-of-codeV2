# Senior verdict — junior auto-warmup (`wt/junior-auto-warmup`)

**Verdict: APPROVE**
**Reviewed hash:** `c3a4b07` (round-1 `23b1a69` + round-2 wiring fix)
**Reviewer:** senior (Claude/Opus). **Stream:** engine-dev, cut from main `8482c2f`.
**Plan:** `docs/plan-junior-auto-warmup.md` (rev 2, senior-reviewed).

## What it delivers
Restores automatic opening of cold Antigravity juniors, the behavior C3
(`b671157`) regressed by putting a probe-only health gate ahead of the dispatch
step that used to launch. A background `JuniorWarmer` opens cold juniors off the
100ms poll loop; admission stays the fail-closed C3 CDP probe.

## Round-1 review → REVISE (one blocking finding)
Boot-warm was wired into the Runner, but the **live reconcile sweep passed no
`requestWarmup` hook** — so in production the `probe_failed` trigger never fired
(post-boot cold starts silently re-wedged) and the R2 quiet rule was dead code
(every healthy boot-warm still paged "queue may be stalled" 1–3×). Sent back.

## Round-2 fix → verified
- `runner/main.ts` live sweep now passes
  `requestWarmup: j => this.warmer.request(j, 'probe_failed')`.
- New **through-the-runner** test starts a real Runner loop with an injected
  warmer + a driver-override probe forced to fail (hermetic — no real CDP):
  asserts the live sweep requests `probe_failed` warms for A+B and writes the
  quiet `queue_probe_warming` span with no roster-exhausted page.
- Spawn-hazard audit (wiring the hook could fire a real warmer in any live-loop
  test with a queued candidate): all live-loop tests confirmed to have no
  admissible queued candidate / driver overrides / no started loop. Documented.
- Cap-fire minor disclosed in code (inner attempt keeps running, no backoff
  timestamp; defensive-only — ensure self-times-out at 90s ≪ 180s cap).

## Design invariants preserved
Admission still requires a passing CDP handshake; broken/wedged juniors still
fail closed loud; warmer gates on its own in-flight map + 60s backoff, never
`isJuniorHealthy` (avoids the §4.1 self-deadlock); `ensureJuniorRunning` called
without `db`, one cooldown clear after readiness; warm success == the admission
probe passes (readiness loop over the same seam). Mutations M-AW1…7 (+ round-2
M-AW1b/M-AW7b through the runner) recorded in `docs/mutation-evidence-phase8.md`.

## Verification (senior re-ran)
- `tsc --noEmit` clean.
- Touched files 33/33 green.
- Full suite: 906/909, the 3 failures = `t4_crash_resume` + `tc_primary_contamination_guard`
  (N16), both **16/16 green in isolation** — the ledger-documented parallel-load
  flake class, causally disconnected (those tests have no queued candidate, so
  the new hook never fires). None in a file this stream touched.

## Scope note (not a defect)
The junior roster is A + B only. This makes **2-concurrent** work automatically;
true 3-concurrency needs a third junior — a separate stream.

Delivered to local `main` by operator authorization (engine-dev stream cannot
ride the wedged queue; C-series precedent). Not pushed.
