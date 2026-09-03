# Verdict — per-junior `--user-data-dir` (Antigravity single-instance-lock fix)

**Verdict: APPROVE** (acting junior + senior for this fix, operator request, 2026-09-03). Local main only.

## The bug
`ensureJuniorRunning` launched the junior IDE with only `--remote-debugging-port=<port>`
and **no `--user-data-dir`**. Antigravity (an Electron app) enforces a
single-instance lock keyed to the profile (user-data-dir): if ANY Antigravity is
already running on the default profile — a stale/wedged leftover, or the
operator's own window — a second launch is **absorbed** by it and exits WITHOUT
binding the debug port. The port never opens → `"<junior> launched but no CDP
endpoint on port <port> within timeout"` (the 2026-09-03 N9 plan.cycle death).

Diagnosis was reproduced live: a 2nd launch on a fresh port while an instance ran
never bound; the same launch WITH `--user-data-dir` bound in ~3s.

## The fix
- `antigravityUserDataDir(port)` — a STABLE, per-junior profile dir keyed by port
  (`<LOCALAPPDATA>/bureau/antigravity-profiles/<port>`; A=9333, B=9334),
  overridable via `ANTIGRAVITY_USER_DATA_DIR_<port>`. Persistent (never a temp)
  so the profile's one-time sign-in survives.
- `buildAntigravityArgs(port, userDataDir?)` appends `--user-data-dir` when given
  (omitted = legacy args, so the existing surface is unchanged).
- All three launch paths — `ensureJuniorRunning`, `forceCleanRelaunch`
  (`recoverJuniorRunning`), and the bare-port `ensureAntigravityRunning` — now
  `mkdirSync` the per-port profile and launch on it, so a junior always gets its
  OWN lockable instance that binds its port regardless of any other Antigravity.

## Operator note
A fresh profile dir starts **signed out**. Sign the junior's Antigravity in ONCE
in that profile, or set `ANTIGRAVITY_USER_DATA_DIR_<port>` to an already-signed-in
profile to reuse it.

## Verification
- Unit: new cases for `buildAntigravityArgs` with the dir + blank-dir guard;
  `antigravityUserDataDir` stable/per-port/override; `recoverJuniorRunning`
  spawn-arg assertions updated.
- **Live E2E through the real harness:** stale default-profile instance holding
  the lock (port 9334 dead) → `ensureJuniorRunning(B)` bound 9334 in **1.7s**,
  `launched:true` — the exact 04:24 failure, now passing.
- **Full suite 785 passed** (the lone `t4_crash_resume` miss is the known
  parallel-load flake — passes in isolation), `tsc --noEmit` clean.

## Follow-up (not in this change)
`forceCleanRelaunch` still kills by image name (all Antigravity of that binary);
with per-profile isolation the more precise recovery would target only the
junior's own profile/port. Separate change.
