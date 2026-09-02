# Bureau Roadmap — Dept of Code Improvements + the Reusable Bureau Kernel

**Purpose.** Two plans in one document: (A) the highest-leverage improvements to
the Department of Code itself, and (B) the design of a reusable base — the
**Bureau Kernel** plus a **Department Kit** — so that every new department the
operator opens (Reddit, HFT, risk analysis, …) is *instantiated, not re-built*:
same laws, same structure, same efficiency, by construction.

Grounded in the tree at `main` = `562d2a9` (2026-08-26), suite 435/435 across
94 files, `tsc --noEmit` clean (re-verified this session). Inputs:
`docs/DEPARTMENT_STATUS.md`, `docs/blueprint-context.md` (the kernel/payload
split analysis), the two operator-provided research blueprints (comparative
analysis vs AutoDev/OpenHands/SWE-agent; the reusable-kernel research plan),
and git history.

Like `blueprint-context.md`, this file is **deliberately untracked** —
committing it is the operator's decision, through the normal flow. Nothing here
changes any law; the merge law, review loop, and mutation-evidence rule stay
absolute for every stream this roadmap spawns.

---

## 0. Where the department actually stands (the honest baseline)

- Phase 7 (live operation) in flight. Two real tasks shipped end-to-end
  (`c7f9b37`, `1c14534`); plan→work loop closed; 435/435 + build clean.
- **Workspace reconciliation has STARTED**: `0ca54f6` opens a dedicated
  Antigravity IDE window *on the bureau worktree*, so the junior's edits/commits
  land on the delivery branch. The remaining gap is the **tail**: `verify.run →
  needs-review` against the junior's actual branch, so a task can reach `done`
  through the tracked path. Until then, hand-merges stay paused.
- Open Phase-7 items: A2 (`[llm]` span provider-doubling), A3
  (budget-refusal proof), C1 (delivery against a sandbox remote).
- Known debt: `fileParallelism:false` band-aid (the `t30` full-suite flake is
  this class); cost columns have not met a real bill; declared-but-unused state
  edges (`intake`, `failed`, `verifying→failed`, `failed→claimed`,
  `claimed→queued`).
- Phase 8 is already earmarked in the ledger: multi-task / concurrency at
  scale.

Everything below sequences against this reality, not against the research
papers' idealized starting point.

---

# PART A — Improvements to the Department of Code

Ordered by leverage: each item unblocks or de-risks the ones after it.

## A1. Close workspace reconciliation — then enforce the merge law with tooling

**Why first:** it is the single remaining gap between "the machine works" and
"the machine finishes." It re-opens the tracked delivery path
(`verify.run → needs-review → approve → pr.create → pr.merge → done`), lets the
hand-merge pause be lifted, and restores zero out-of-band delivery. It is also
the prerequisite for trusting *any* later automation (concurrency, new
departments).

Scope:
1. **Finish the tail.** After the junior commits on the worktree branch
   (dispatch already lands there since `0ca54f6`), wire `verify.run` to run
   against that branch's worktree, transition `claimed → verifying →
   needs-review` on exit 0, and let the existing approve/PR/merge doors carry
   it to `done`. No new gates; no gate weakened. The done-gate CHECK stays
   exactly as is.
2. **Prove it live**: one real task reaches `done` through the tracked path —
   `bureau_jobs` rows for `verify.run`/`pr.create`/`pr.merge`, merge journal
   spans, `merged_at/by` set — with zero human git commands.
3. **Machine-enforce the merge law** (currently law + review discipline only,
   per blueprint-context item 3): a local pre-merge git hook (and, where the
   host supports it, a server-side pre-receive) that refuses any merge to
   `main` whose target commit hash lacks a delivery-path journal span + Senior
   verdict in the department DB. The 2026-08-24 out-of-band incident becomes
   structurally impossible, not merely forbidden.
4. **Then lift the hand-merge pause** by operator decision, recorded in the
   ledger.

Exit: a real task auto-completes to `done`; a hand-merge attempt is refused by
the hook (demonstrated, with the refusal journaled as a guardrail span).

## A2. Finish Phase 7's leftovers (small, known, cheap)

- **A2 provider-doubling**: fix the `ollama/ollama` attribution in the
  dispatch→`callModel` path; one span, provider read once. Cosmetic but it
  poisons cost rollups.
- **A3 budget-refusal proof**: a run that would exceed a ceiling
  (`plan_rounds` / `verify_fixes` / `attempts` / rolling-24h token+request
  budgets) is *refused* with a guardrail span — mutation-proven (remove the
  check → the run overspends → test fails).
- **C1 delivery against a sandbox remote**: `pr.create`/`pr.merge`/
  `backup.push` exercised against a throwaway remote with the
  remote-tip-readback anti-false-claim check, not just fakes.

These three are prerequisites in spirit for Phase 8: you cannot scale
concurrency on top of unproven budget refusal or unexercised delivery.

## A3. Multi-tier verification (staged verify pipeline)

Today verification is one command, one exit code. The research is right that
this is thin; the fix must **keep the kernel contract** (deterministic,
bureau-owned command, exit code 0) while making the *command* smarter.

Design: the verify step becomes a staged pipeline, each stage a bounded command
with its own timeout, all inside the existing `verify.run` job:

1. **Stage 0 — structural**: `tsc --noEmit` + linter on changed files (fast
   failure; catches the "greenwashed build" class of scar).
2. **Stage 1 — fail-to-pass (targeted)**: tests named by the task's acceptance
   criteria. Requires intake to record *which* tests prove acceptance (extend
   the officer's drafted fields; human confirm-verify gate covers them).
3. **Stage 2 — pass-to-pass (regression)**: the full suite; the run row records
   the pass counts before/after so the ledger can prove *no regression*, the
   `S_maintain`-style trajectory the research asks for — computed from data we
   already store, no new machinery.
4. **Stage 3 (later, optional)** — mutation spot-check on the diff's own guards
   (this department already has the mutation discipline; automate a sample).

Failure at any stage = the existing bounded fix loop (`verify_fixes`, ceiling →
`blocked`). AST/fuzz stages from the research are deferred — stages 0–2
capture most of the value for a fraction of the machinery.

## A4. Test-infrastructure debt (precondition for Phase 8 at scale)

Retire `fileParallelism:false`: convert the wall-clock waits in the browser /
 crash-kill tests (`t28`, `t38`, `t30`'s class) to deterministic event/row
synchronization (`test/helpers/wait.ts` pattern, already proven on T4b). Suite
time ~2 min today; parallelism plus determinism is what makes concurrency
development survivable.

## A5. Cost accounting meets reality

`cost_usd` + `cost_recorded` exist; budgets have never met a real bill. Wire
per-model pricing into the ledger rollups (meta-keyed, updatable), keep the
honesty flag (`cost_recorded: false ≠ $0`), and produce one real monthly-style
rollup from the live journal. This is also the kernel's generic
spend-guard proving ground before a department whose unit is capital-at-risk
(HFT) rather than tokens.

## A6. Concurrency at scale — Phase 8 (already planned, unchanged)

Many tasks × both juniors × real leases: secretary contention, watchdog under
load, queue fairness, per-project serialization. A1–A4 are its preconditions.
No change to the ledger's scope; this roadmap only supplies the ordering.

## A7. Deliberately deferred improvements (adopt when a trigger fires)

| Improvement | Trigger | Why deferred |
|---|---|---|
| **Container sandbox** (`AgentWorkspaceBinding` as a `WorkspaceProvider` impl: Docker/WSL2, mounted repo, egress-restricted) | Phase 10+, or first untrusted-code task | gVisor/eBPF are Linux-only; this is a Windows-first shop. Keep it a pluggable provider — never a rewrite. Local worktrees remain the default. |
| **Synthetic self-benchmarking** (Agent-SWE-style feature-deletion tasks run in idle time) | After kernel extraction | Valuable for tuning prompts/selectors; a consumer of the machinery, not a prerequisite. |
| **Task dependency graphs / dynamic topologies** (DyTopo, ROMA-style recursive decomposition) | First genuinely multi-part task | The bounded deterministic loop IS the product (provenance over cleverness). Add a `depends_on` column + scheduler rule when a real task needs it — not research-driven speculation. |
| **Multi-senior quorum** | First department whose risk profile demands it (HFT: risk + correctness) | The assignment policy is already pluggable (`assignSeniorForTask`); make quorum a policy option then. |
| **Dead state edges** (`intake`, `failed`, …) | During kernel extraction | Either wire retry semantics or delete them to shrink the CHECK surface — decide once, in the kernel, not per department. |

---

# PART B — The reusable base: Bureau Kernel + Department Kit

## B1. Principle

The split already exists in embryo (the seams are exactly the domain boundary —
blueprint-context §7). The work is to make it *physical and enforced*:

> **Kernel** = the governance spine: how work is filed, bounded, verified,
> reviewed, human-gated, delivered, journaled, and observed. Knows nothing
> about code, posts, or trades.
> **Payload** = everything domain-specific, plugged into kernel seams.

A new department is a **payload package plus a declaration** — never a fork of
the engine.

## B2. Target monorepo layout

npm workspaces are already in use (`engine`, `runner`); extend, don't invent:

```
/packages/kernel/        @bureau/kernel — everything in B3 below
/packages/console/       @bureau/console — console skeleton (token auth,
                         POST-only mutations, job-trigger buttons, runner split)
/departments/dept-code/  the existing department as the first payload
/departments/dept-<x>/   future departments (reddit, hft, ...)
/db/<dept>.db            ONE SQLite store per department (isolation by default)
```

One repo first (single review loop, shared scars ledger). Publishing packages
or splitting repos comes only if a department needs to live elsewhere.

## B3. What moves into `@bureau/kernel` (freeze list)

From the current `engine/`, essentially all of it, re-homed:

- `contract/` — vocabularies (states, roles, span/job kinds), attribution
  tuple, seams + fail-closed getters, validation (scrubEnv/redactOutput),
  budget/meta key namespaces.
- `db/` — boot-migration door, schema, done-gate CHECKs, per-instance open
  (path-parameterized: each department points at its own `db/<dept>.db`).
- `state/` — role-gated machine, single-writer doors, orthogonal human tags.
- `jobs/` — claim/lease/heartbeat/reap/dead-letter/backoff, deterministic ids,
  chaining-in-transaction, `excludeKinds` co-location, `drainSingleJob`.
- `journal/` + `ledger/` — the one door, append-only triggers, rollups.
- `llm/` — `callModel` choke point, budget guard, rotation/steering, mock.
- `harness/` — CDP detect-or-launch, verified sends, adaptive wait, selector
  calibration gate, nonce correlation, window leases (generic agent-GUI
  machinery, not IDE-specific).
- Support: watchdog, secretary, dashboards, notifications (event catalog),
  projects, assets.
- `runner/` — the loop, provider wiring.
- **The process layer** (this is what makes new departments *efficient*, not
  just structured): templates for `AGENTS.md`, `DEPARTMENT_STATUS.md`,
  phase rough/plan/brief/verdict/mutation-evidence docs, the scars-ledger
  format, the test law + shared fakes + fixtures.

What stays OUT of the kernel (dept-code payload owns it): the intake officer's
prompt + tool schemas, verify command semantics, worktree/git workspace
provider, PR delivery provider, junior/senior rosters + their calibration,
plan/work rubric prompts, domain watchdog classes, notification wording.

## B4. The Department Kit — one declaration, fail-closed

A department is a single TypeScript registration (mirrors the seam pattern —
no config parsing layer, no hidden defaults; anything unregistered throws):

```ts
// departments/dept-reddit/definition.ts
export const redditDepartment: DepartmentDefinition = {
  name: "reddit",
  dbPath: "db/reddit.db",
  officer:      { prompt: officerSystemPrompt, tools: officerTools },
  taskShape:    { extraFields: "subreddit, tone, policy_refs", acceptanceToTests: true },
  workspace:    RedditDraftSandbox,        // implements WorkspaceProvider
  verification: verifyPostPolicy,          // deterministic cmd, exit-code contract
  delivery:     ScheduledApiPublish,       // implements DeliveryProvider
  juniors:      [researchRoster, draftRoster],
  seniors:      [policyReviewer],
  budgets:      { postsPerHour, karmaAtRisk, tokenCeilings },
  watchdog:     { extraClasses: [stuckSubmission, rateLimitProximity] },
  notifications:{ events: redditEventCatalog },
  console:      { tabs: [/* queue, modlog, ... */] },
};
```

The kernel exports `openBureau(definition)` — one door that opens the DB (boot
migrations), registers seams, seeds rosters/ceilings, and returns the runner +
console wired for that department. The same call is used by the CLI, the
runner, and the console, so there is exactly one way to boot a department.

## B5. "Proper structure all the time" — the three guarantees

The operator's requirement is that new departments are efficient and properly
structured *every time*. Discipline alone has already failed this department
once (the out-of-band merges). So the guarantee is machinery:

1. **Scaffold CLI** — `npm run bureau:new -- --name reddit` stamps out
   `departments/dept-reddit/` from the kit (definition stub, provider stubs
   with TODO gates that throw until implemented, test skeleton, docs templates
   pre-filled: AGENTS.md, status ledger, integration manual). A new department
   *cannot* start with a blank page or a copy-paste drift.
2. **Kernel-conformance suite** — shipped with `@bureau/kernel`, run against
   every department's real (temp) DB + seams. A department is not "open for
   business" until green. It re-proves, per department, the invariants this
   department paid for in blood:
   - done-gate: raw-SQL attempt to forge `done` without verifier 0 + approval
     is refused by the CHECK;
   - merge-gate: `merged_at` without `done` refused;
   - journal: UPDATE/DELETE on spans refused by triggers; whole-DB scan with a
     real-shaped secret finds nothing (key hygiene);
   - budgets: ceiling-exceeding run *refused* with a guardrail span;
   - seams: unregistered seam throws (fail-closed);
   - verify tampering: vacuous verify commands refused at intake; verify_cmd
     read from DB, never workspace;
   - test law: the department's own suite passes with network access denied;
   - merge-law hook: a hand-merge to the dept's main is refused without a
     delivery-path span for that hash.
3. **First-light run** — one real, supervised task through the full flow
   (intake → … → done, every gate firing) recorded in the new department's
   journal + ledger, exactly like this department's Phase 7. Conformance proves
   the machine; first light proves the *payload*.

Together: scaffold guarantees structure, conformance guarantees law, first
light guarantees the domain wiring — and none of them depend on anyone
remembering the rules.

## B6. Isolation and federation rules

- **One SQLite file per department** (`db/code.db`, `db/reddit.db`, …). The
  live-DB scar generalizes: a corrupted migration or table lock in one
  department cannot touch another; budgets/ceilings are per-department.
- **One console per department** (same skeleton), loopback + token as today.
- **Cross-department work is inter-bureau intake** — an explicit job that
  files a task in the other department's DB (journaled on both sides), never
  shared tables. A unified overview console is built only after 2+ departments
  exist and prove the need ("federate later, isolate first").

## B7. Extraction rules (how Phase 9 avoids becoming a rewrite)

- **Behavior-preserving move**: code moves, not changes. The proof is suite
  parity — the full existing suite, unmodified in intent, green against the
  re-homed kernel, run twice, plus build. Any intentional change is its own
  milestone with its own mutation evidence, never smuggled into the move.
- **No payload leakage**: kernel tests grep-gate the kernel for
  department-specific strings (worktree paths, IDE names, verify vocab);
  contract-freeze tests per kernel surface, exactly like today's
  `contract_d0*`.
- **Dept-code becomes payload consumer #1** with zero feature change; its
  435-test suite is the kernel's acceptance test.
- The dead-edge decision (B3/A7) is taken here, once, for all future
  departments.

---

# PART C — Sequencing (phases, exit sentences)

The department's own methodology is kept: each phase below still gets a rough →
frozen plan, a D0 freeze, streams, briefs, verdicts, and a ledger row. This
roadmap only fixes order and content.

| Phase | Scope | Exit sentence (quotable) |
|---|---|---|
| **7 close-out** | A1 reconciliation tail + merge-law hook; then A2/A3/C1 leftovers | "One real task reaches `done` through the tracked path with zero human git commands, and a hand-merge is refused by tooling." |
| **8** | Concurrency at scale (as already planned), with A4 test determinism as its D0 | "N concurrent real tasks across both juniors with leases, watchdog, and budgets holding — no stranded states, no flakes." |
| **9 — Kernel extraction** | B2–B7: monorepo re-home, Department Kit, scaffold CLI, conformance suite | "Dept-code runs unchanged as payload #1 on `@bureau/kernel` (suite parity, run twice), and `bureau:new` stamps out a toy department that passes kernel-conformance and ships one supervised task to `done`." |
| **10 — First real new department** | The operator's chosen domain via the kit; A3 multi-tier verification as payload-level stages; optional container-sandbox provider if the domain needs it | "Department #2 opens for business through scaffold → conformance → first light, with zero kernel changes." |
| **Beyond** | Federation overview (only when 2+ depts), synthetic self-benchmarking, dependency graphs, quorum review — each on its A7 trigger | — |

If a new department becomes urgent, 9 may swap ahead of 8 (they are
orthogonal: 8 is internal scale, 9 is replication) — an explicit operator
decision recorded in the ledger, not a silent reorder.

---

# PART D — Operator decisions (before Phase 9 is frozen)

1. **Monorepo vs published packages** — recommend monorepo (single review
   loop, one merge law); revisit only when a department must live off-repo.
2. **Dead state edges** — wire `failed`-retry semantics or delete them from
   the kernel. Recommend: delete now, re-add when a real retry need exists.
3. **First new department** — which domain (Reddit? HFT?). Recommend the one
   with the cheapest deterministic verifier first (Reddit's policy-check
   script) — it exercises the kernel without code-execution risk.
4. **Container sandbox posture** — confirm Windows/WSL2 Docker availability
   before promising any sandbox milestone; otherwise it stays an A7 trigger.
5. **Spend caps for Phase 8/10 live runs** — unchanged rule: keys in env,
   ceilings in meta, refusal proven, human approves crossing.

---

# PART E — Deliberately NOT adopted from the research blueprints

Honest pushback, so the record shows these were considered and declined (for
now), not overlooked:

- **Event-sourced rewrite (WebSocket/REST control plane)** — the journal +
  jobs tables *are* the event log, transactionally. An in-process SQLite
  choke point is this system's strength (single-writer doors, CHECK floors);
  a service mesh would trade proven invariants for distribution we don't need
  at this scale.
- **gVisor/eBPF microVMs as the baseline** — Linux-only; this is a
  Windows-first bureau. Sandboxing enters as one optional
  `WorkspaceProvider`, on its A7 trigger.
- **Dynamic topology routing / recursive meta-agents (DyTopo, ROMA)** —
  research-grade, non-deterministic. The department's product is provenance:
  bounded, role-gated, reviewable loops. Adopt graph scheduling when a real
  multi-part task demands it.
- **MCP-first tool standardization** — the seam registry already provides the
  testability and fail-closed guarantees; MCP becomes interesting when
  departments need *external* tool ecosystems, not for internal seams.
- **Pass@1-style benchmark targets as engineering gates** — useful for
  evaluating model swaps; kept out of the definition of done (which stays:
  verifier exit 0 + human approval, DB-enforced).

---

*Prepared 2026-08-26 from `main` = `562d2a9` (suite 435/435 ×1 this session,
build clean). Untracked by design; the operator files/commits it through the
normal flow if accepted.*
