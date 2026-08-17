# Phase 5 (rough) — Hardening

Rough outline for planning; not yet a frozen plan. Each item below is
motivated by a real incident from Phases 0–3 where the fix was manual.

## Scope sketch

- **Watchdog**: a periodic job that detects stranded states and rings the
  operator — tasks in `verifying` with no pending `verify.run` and a done
  job (the exact crash window the WX-1 review closed in code; the watchdog
  is the belt-and-braces), leases past expiry, jobs dead-lettered with
  retries left, dispatches with no live lease. Detection is read-only;
  recovery actions are themselves jobs, journaled, never fire-and-forget.
- **Backup push automation**: origin/main sat 10+ commits behind through all
  of Phase 2 — the department's history existed on one machine. After every
  Operator merge: push, and verify the remote tip matches (a job or a merge
  hook, not a human memory).
- **Secretary**: cross-window coordination — the thing this department ran
  without while windows churned one clone between juniors. A single
  authoritative "who owns which branch/window" table (DB, not chat),
  enforced checkout discipline, and handoff notes richer than the ledger's
  In-flight row.
- **Dashboards**: read-only views over the journal and task tables —
  budget spend, state populations, verify failure rates, time-in-state.
- **Red-team sweep**: the two Phase 2 rules (bureau-owned verify command,
  scrubbed env) get a standing adversarial test suite; add
  workspace-content prompt injection against the Phase 4 officers, verify
  output exfiltration attempts, and selector spoofing against the Phase 3
  calibration gate.
- **Flake hardening**: the T4 lease-reap poll and any Phase 3 timing tests
  move to deterministic synchronization (wait on files/DB rows/browser
  events, not wall-clock sleeps).
- **Suite duration budget**: integration suite is ~30s and growing;
  introduce sharded or tagged runs if it crosses a pain threshold, without
  ever letting a red suite look green.

## Exit sentence (draft)

The department survives its own failures: stranded work is found and rung,
history exists in more than one place, windows hand off through the record
not the chat, and the red team's best shots end in guardrail spans.
