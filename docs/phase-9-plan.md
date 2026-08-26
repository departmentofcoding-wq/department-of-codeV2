# Phase 9 Plan — Bureau Kernel Extraction + Department Kit (frozen outline)

Status: **plan outline**, to be frozen for execution by a fresh window. Cut from
`main` after Phase 8. Sourced from `docs/plan-bureau-kernel-roadmap.md` (Part B)
and `docs/blueprint-context.md` (§7, the kernel/payload split).

## What Phase 9 is

Make the kernel/payload split — which already exists in embryo as the seams —
**physical and enforced**, so every future department is *instantiated, not
re-built*. Extract the governance spine into `@bureau/kernel`; make dept-code
"payload consumer #1" with **zero behaviour change**; and add the machinery that
guarantees new departments are proper by construction, not by discipline (which
has already failed this department once).

This is a **behaviour-preserving move**, not a rewrite. The proof is suite
parity: the full existing suite, unmodified in intent, green against the
re-homed kernel, run twice, plus build.

## Exit sentence

> "Dept-code runs unchanged as payload #1 on `@bureau/kernel` (suite parity, run
> twice, build clean), and `bureau:new` stamps out a toy department that passes
> the kernel-conformance suite and ships one supervised task to `done`."

## Safety posture

- Behaviour-preserving move: code moves, it does not change. Any intentional
  change is its own later milestone with its own mutation evidence — never
  smuggled into the move.
- No payload leakage: kernel tests grep-gate the kernel for department-specific
  strings (worktree paths, IDE names, verify vocab); per-surface contract-freeze
  tests, exactly like today's `contract_d0*`.
- One SQLite DB **per department** (the live-DB scar generalizes); shared code,
  isolated state.

## Target layout (npm workspaces already in use)

```
/packages/kernel/        @bureau/kernel — the governance spine (B3 freeze list)
/packages/console/       @bureau/console — console skeleton
/departments/dept-code/  the existing department as payload #1
/db/<dept>.db            one store per department
```

## D0-9 — Kernel contract freeze (do FIRST)

- Freeze `@bureau/kernel`'s public surface: `openBureau(definition)`, the
  `DepartmentDefinition` type, and the seam interfaces (LLM, workspace,
  verification, delivery, IDE, senior, backup, ntfy). Contract-freeze tests per
  surface, merged before any move.
- Decide the dead-edge question **once, here** (`intake`, `failed`,
  `verifying→failed`, `failed→claimed`, `claimed→queued`): wire retry semantics
  or delete them to shrink the CHECK surface. Recommendation: delete.

## Stream A — Move the spine into `@bureau/kernel`

Re-home, unchanged: `contract/` (vocab, seams, validation), `db/` (boot door,
schema, done-gate CHECKs, per-instance path), `state/` (role-gated machine,
single-writer doors), `jobs/`, `journal/` + `ledger/`, `llm/` (choke point,
budget guard), `harness/` (generic agent-GUI machinery), watchdog, secretary,
dashboards, notifications, runner, console skeleton — **plus the process layer**:
AGENTS.md / status-ledger / phase templates, the test law, shared fakes.
Acceptance: dept-code's 479-test suite green against the kernel, twice.

## Stream B — The Department Kit + the three guarantees

A department becomes **one declaration** (`DepartmentDefinition`) passed to the
single `openBureau()` door — fail-closed, no hidden defaults. Machinery, not
discipline, guarantees "proper every time":
1. **Scaffold CLI** — `npm run bureau:new -- --name <x>` stamps a department from
   the kit (definition + provider stubs with TODO gates that throw until
   implemented, test skeleton, pre-filled docs). No blank page, no copy-paste drift.
2. **Kernel-conformance suite** — shipped with the kernel, run against each
   department's real temp DB + seams; a department is not "open for business"
   until green. Re-proves per department: done-gate raw-SQL forgery refused,
   journal append-only triggers, whole-DB key-hygiene scan, budget refusal,
   fail-closed seams, vacuous-verify refusal, and the **merge-law hook**.
3. **First-light run** — one real supervised task through the full flow, recorded
   in the new department's journal + ledger.

## Out of scope (defer)

- The first *real* new department (Phase 10) — Phase 9 proves the kit with a toy.
- Federation / cross-department console (only after 2+ departments exist).
- Publishing packages / splitting repos (monorepo first — Part D decision).

## Definition of done

D0-9 + Streams A & B merged with posted Senior verdicts; dept-code suite parity
(twice) + build green; `bureau:new` toy department passes kernel-conformance and
ships one supervised task to `done`; ledger updated.
