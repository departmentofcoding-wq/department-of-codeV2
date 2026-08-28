# Walkthrough — Department resilience (wt/dept-resilience)

**Implementer:** zai (ZCode/GLM) · **Plan:** "Department resilience — auto-recover a
downed junior/senior, adaptive claude timeout, and scar hardening" (dept-of-code-v2-88)

The department now runs unattended: a downed or wedged junior/senior GUI is
restarted and the work continues instead of dying fail-closed; the claude senior
can work as long as it keeps producing output; and the scars found during the
2026-08-28 resume are closed. The done-gate, attribution/journal machinery, and
the fail-closed "a partial run is never a verdict" philosophy are untouched.

## WS1 — Auto-restart a downed SENIOR (ZCode/GLM) and continue

`engine/harness/senior.ts`:

- **`killSeniorProcesses(cfg)`** — best-effort kill of every process of the senior
  app (`taskkill /IM "ZCode.exe" /F` on Windows, `pkill -f` elsewhere). Never
  throws; "not found" is fine. Required because ZCode keeps a **tray process
  holding the single-instance lock** — a plain relaunch hands off to it and the
  debug port never comes back.
- **`seniorProcessImageName(cfg)`** (pure) — derives the exe name from the
  `ZCODE_PATH` override or the registry's absolute candidate.
- **`ensureSeniorRunning(cfg, { timeoutMs?, deps? })`** — mirrors the junior side's
  `ensureJuniorRunning`: port live → reuse (`launched:false`); else kill zombies →
  spawn the binary with `--remote-debugging-port=<cdpPort>` (detached, unref) →
  poll the port until live (default 40s) → throw only if it never comes up.
  Everything (port probe, killer, launcher, sleep) is injectable via `deps` so the
  policy is unit-tested without touching a real GUI.
- **`isSeniorConnectionError(err)`** (pure classifier) — true for CDP
  socket/attach/answer deaths (ECONNREFUSED, WebSocket failures, "main window not
  found on port", "CDP timeout"); deliberately false for home-screen captures,
  selector-calibration misses, and stalls — those stay fail-closed.
- **`runSeniorWithRecovery(cfg, op, deps?)`** — the mid-review retry wrapper:
  ensure the app, run the review; on a connection-classified death relaunch ONCE
  and retry the whole sequence; a second failure — or any non-connection failure —
  propagates (partial output is never a verdict).
- `ZCodeSenior.review` now = lock (WS4b) → `runSeniorWithRecovery` → the old
  attach→newConversation→sendPrompt→wait→guard→parse body (`reviewOnce`). The old
  "relaunch it by hand" throw is gone.

## WS2 — Auto-restart a downed/WEDGED JUNIOR (Antigravity) and continue

`engine/harness/antigravity.ts`:

- **`killJuniorProcesses(cfg)`** + **`juniorProcessImageName(cfg)`** — same shape
  as the senior side (`taskkill /IM "Antigravity IDE.exe" /F` etc.).
- **`recoverJuniorRunning(cfg, { timeoutMs?, deps? })`** — a FORCED clean
  relaunch: unlike `ensureJuniorRunning` (which no-ops when the port is live), it
  **always** kills and relaunches — the fix for a WEDGED instance whose port
  answers but whose windows never come up (dead job `8c6f373e`).
- **`isJuniorWedgedWindowError(err)`** (pure) — matches exactly the two real
  wedge messages ("no CDP window titled … appeared within timeout" /
  "workbench window did not become available").

`engine/harness/dispatch-job.ts`:

- **`runJuniorCommandWithWedgedRecovery(driver, prompt, opts, recover?)`** — used
  by `handleJuniorDispatch` for the junior run: on a wedged-window failure it
  calls `recoverJuniorRunning` for the selected junior and retries the run ONCE
  within the same dispatch attempt, instead of burning all attempts against the
  same dead instance. Non-wedged failures propagate untouched. The `recover` seam
  keeps the retry policy unit-testable with a fake driver.

## WS3 — Claude senior timeout: adaptive, so it can work fully

- New **`engine/harness/inactivity-guard.ts`** — `makeInactivityGuard({ stallMs,
  maxMs, onGiveUp })` returning `{ touch, done }`: a stall timer that resets on
  every `touch()` (stdout/stderr `data`), plus an absolute cap from creation.
  `onGiveUp` fires at most once with `'stall' | 'cap'` (+ silent/elapsed info);
  `done()` (natural close) disarms everything.
- `ClaudeCliSenior.spawnClaude` now uses the guard: every output chunk touches it;
  a stall or the cap kills the tree and rejects — partial output is NOT resolved
  as a review; natural `close` resolves exactly as before.

## WS4 — Scars from the 2026-08-28 resume

### 4a. Stale ZCode home-screen markers

`SENIOR_HOME_SCREEN_MARKERS` retightened. I verified the live DOM against ZCode
3.9.2 (read-only CDP probes on the running instance, plus one new-task screen
opened via the harness's own `conversation-new-task` selector and then restored):
the old markers — *Add context*, *Full access*, *Ask before changes*,
*Edit automatically*, *Plan mode* — are **persistent composer chrome, visible
during an active conversation** (the permission dropdown renders with its
descriptions), so a genuine verdict-less review quoting them was false-posited as
a home-screen capture. The new set keys on text that renders ONLY on the empty
`chat-empty` screen:

- the greeting hero `Good morning/afternoon/evening! …` (time-of-day variant),
- `Select project`,
- the hero hint `Ask ZCode anything, @ to add context, / for commands or capabilities`,
- the template suggestion cards (`Weekly Summary`, `PPT Creation`, `Idle-time
  task`, plus the two card texts seen in the 2026-08-28 incident capture — they
  rotate daily).

The guard keeps the "≥2 markers AND no VERDICT line" rule and stays fail-closed.
Tests updated accordingly (see below).

### 4b. Single-ZCode-instance mutex

New **`engine/harness/zcode-lock.ts`**: `acquireZCodeLock()` creates a lockfile
(`{pid, acquiredAt}`, exclusive `wx` create) at `%TEMP%\dept-of-code-zcode.lock`
(override: `ZCODE_LOCK_PATH`). A live holder younger than the TTL makes a second
driver wait up to 5s and then **fail fast** with "ZCode is busy" (naming the
holder pid) instead of colliding — a second `newConversation()` resets the first
driver's in-flight review. A stale lock (holder PID gone, corrupt file, or older
than 2h) is taken over. `release()` deletes the file only if it is still ours.
`ZCodeSenior.review` holds it across the whole review, released in `finally`.

### 4c. Stale-runner warning (docs)

One-paragraph notes added to `docs/senior-integration.md` (Preconditions) and
`docs/antigravity-integration.md` (Preconditions): after merging a harness fix,
**relaunch the runner AND the console** — the runner keeps executing old code and
the console mints a new token only on restart.

## New env vars + defaults

| Var | Default | Meaning |
|---|---|---|
| `CLAUDE_SENIOR_STALL_MS` | `300000` (5 min) | Claude senior: no output for this long → kill + reject (stall). |
| `CLAUDE_SENIOR_MAX_MS` | `3600000` (1 h) | Claude senior: absolute last-resort cap (pathological loops). |
| `CLAUDE_SENIOR_TIMEOUT_MS` | *(legacy)* | Still honored as the cap's source when `CLAUDE_SENIOR_MAX_MS` is unset (back-compat). |
| `ZCODE_LOCK_PATH` | `%TEMP%\dept-of-code-zcode.lock` | Location of the ZCode single-instance lockfile. |

Lock behavior constants (code-level, in `zcode-lock.ts`): busy-wait `5000ms`,
stale TTL `2h` (above the 1h last-resort wait cap of any legit review).

## Tests added / updated (all unit, no network, temp paths, fakes for agents)

- **`test/unit/tc_inactivity_guard.test.ts`** (6) — WS3: stall fires after
  `stallMs` of silence (and not a ms earlier); streaming `touch()`es keep it alive
  12x past the stall window; the cap fires even while streaming; stall wins over
  cap in silence; `done()` disarms; give-up info reporting.
- **`test/unit/tc_zcode_lock.test.ts`** (9) — WS4b: acquire/release round-trip;
  second acquire by a live holder fails fast with "ZCode busy" naming the pid;
  re-acquire after release; takeover of a dead-pid lock, of an over-TTL lock, and
  of a corrupt lockfile; release never deletes a taker's lock; `ZCODE_LOCK_PATH`
  override; pure `zcodeLockIsStale` cases.
- **`test/unit/tc_senior_resilience.test.ts`** (17) — WS1+WS3: `ensureSeniorRunning`
  early-return when live (no kill/spawn), kill+relaunch+poll when dead, clear
  throw when it never comes up, refusal for non-CDP seniors;
  `isSeniorConnectionError` positive/negative tables; `runSeniorWithRecovery`
  relaunches exactly once on a mid-review connection death and succeeds on retry,
  does NOT retry a home-screen capture or a calibration miss, propagates a second
  connection failure; image-name/kill-command derivation; the claude timing env
  resolvers (defaults, overrides, legacy `CLAUDE_SENIOR_TIMEOUT_MS`, garbage).
- **`test/unit/tc_junior_resilience.test.ts`** (11) — WS2:
  `recoverJuniorRunning` always kills+relaunches even when the port is live (the
  wedge case), polls until live, throws when even the forced relaunch fails;
  image-name derivation; best-effort kill never throws; wedge-error matcher
  against the two real messages and non-matches; the dispatch wrapper recovers
  once and succeeds on retry, routes at the selected junior, propagates
  non-wedged failures with no recovery, and stops after exactly one recovery.
- **`test/unit/tc_senior.test.ts`** (updated) — WS4a: the incident home-screen
  capture and a LIVE-captured 3.9.2 empty screen are both still flagged; a
  genuine verdict-less review quoting Full access / Add context / the permission
  labels is NOT rejected (the scar); the marker-set assertions now check the
  live empty-screen signals and that the retired chrome labels are gone; the
  slice-then-guard continuation-round fixture now uses real home-screen text.

Full suite: `npm test` green (109 files / 570 tests, up from the 105/522
baseline), `npm run build` (tsc --noEmit) clean.

## Live checks run during implementation

- **ZCode 3.9.2 home-screen calibration (WS4a)** — done live, read-only probes
  over CDP 9335 against the running ZCode: enumerated visible chrome on an active
  conversation, opened one new-task screen via the harness's own
  `[data-testid="conversation-new-task"]` selector, captured the full empty-screen
  text (greeting hero, Select project, "Ask ZCode anything…" hint, template cards
  of the day), then switched the GUI back to the operator's conversation
  (`[data-testid=conversation-section]` row click; verified back: `chat-empty`
  gone, conversation text present). Findings are what the new marker set is built
  on; details in the WS4a section above.

## Manual checks remaining (need a free GUI — do NOT run from inside a ZCode session)

1. **WS1 live:** kill every ZCode process, then
   `node --experimental-strip-types scripts/run_senior.ts --senior zai --kind plan --task <id> --title "..."`.
   Expected: the harness auto-launches ZCode with `--remote-debugging-port=9335`
   and returns a real verdict (no manual relaunch step).
2. **WS2 live:** wedge a junior (e.g. an instance answering CDP with no usable
   window — or simulate by killing the GUI mid-dispatch) and confirm a
   `junior.dispatch` heals in flight: journal shows one recovery relaunch and the
   attempt completing instead of burning all 3 attempts.
3. **WS4a drift:** after the next ZCode update, re-verify the empty-screen-only
   markers (the template cards rotate; the greeting/hero signals are the durable
   ones) — `SENIOR_HOME_SCREEN_MARKERS` is the single tune point.
