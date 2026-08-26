# Phase 10 Plan — First Real New Department (frozen outline)

Status: **plan outline**, to be frozen for execution by a fresh window. Cut from
`main` after Phase 9. Sourced from `docs/plan-bureau-kernel-roadmap.md`
(Part B/C, Phase 10).

## What Phase 10 is

The payoff: open the operator's first **real** second department through the
Department Kit, with **zero kernel changes**. This is the actual proof the kernel
is reusable, not merely refactored — the flow that says "a department is
instantiated, not re-built" is exercised end-to-end for real.

## Exit sentence

> "Department #2 opens for business through `scaffold → conformance → first
> light` with zero kernel changes, and ships one real task to `done` through the
> tracked path."

## Operator decisions to confirm BEFORE D0-10

- **Which domain first.** Recommendation: the one with the cheapest deterministic
  verifier — a Reddit-style policy-check script — so the kernel is exercised
  without code-execution risk. (HFT waits until a capital-at-risk guard is proven.)
- **Spend/risk caps** for the new department's live runs (keys in env, ceilings
  in meta, refusal proven, human approves crossing).
- **Container sandbox posture**: only if the domain runs untrusted code, and only
  after confirming Windows/WSL2 Docker — otherwise it stays an A7 trigger.

## D0-10 — Department definition freeze (do FIRST)

Author the `DepartmentDefinition` for department #2 via the scaffold CLI, then
freeze it: officer prompt/tools, task shape (+ `acceptance_tests`), workspace /
verification / delivery providers, junior + senior rosters, budgets, watchdog
classes, console tabs. TODO-gated provider stubs throw until implemented. Merged
before streams.

## Stream A — Implement the domain payload

Fill the provider stubs behind the kernel seams — nothing in the kernel changes:
- **Workspace provider**: the domain's isolated per-task sandbox (draft staging /
  content sandbox, not a git worktree).
- **Verification**: a deterministic, bureau-owned command with an exit code (the
  policy checker / rate-limit / format lint) — read strictly from the DB, never
  the workspace; vacuous commands refused.
- **Delivery provider**: the domain's publish path behind a precondition
  transaction (scheduled API submission; live promotion behind the human gate).
- Officer + rosters + rubric prompts + notification wording.

## Stream B — Conformance + multi-tier verification stages

- The department must pass the **kernel-conformance suite** on its real temp DB
  before opening (done-gate forgery refused, journal triggers, key-hygiene scan,
  budget refusal, fail-closed seams, vacuous-verify refusal, merge-law hook).
- Configure the A3 staged-verify stages for this domain (structural → targeted →
  full) via `verify:structural_cmd` + the task's `acceptance_tests`.

## Convergence — first light

One **real, supervised** task through the full flow (intake → plan review →
implement → staged verify → senior review → human gate → deliver → `done`),
recorded in the new department's journal + ledger — conformance proves the
machine, first light proves the *payload*.

## Out of scope (defer to "Beyond", each on its A7 trigger)

- Federation overview console (only after 2+ departments prove the need).
- Multi-senior quorum (when the domain's risk profile demands it).
- Synthetic self-benchmarking, dependency graphs.

## Definition of done

D0-10 + Streams A & B merged with posted Senior verdicts; kernel-conformance
green; first-light task at `done` recorded; **zero kernel changes** in the diff;
ledger updated.
