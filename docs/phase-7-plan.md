# Phase 7 Plan — Live Operation (frozen)

Status: **frozen for execution by a fresh window.** Cut from `main` at `ba3ac1b`.
This plan is written to be run by another session with no memory of this one —
everything needed is here or in the files it cites.

Read `AGENTS.md`, then `docs/DEPARTMENT_STATUS.md`, then this plan, then
`git log` and run `npx vitest run` + `npm run build` (must be green: 232/232,
67 files). The review loop, merge law, and mutation-evidence rule are unchanged
and absolute.

---

## What Phase 7 is — and why it is different

Phases 0–6 **built and unit-proved** the machine and gave it an operator console.
But the department has **never driven one real task end-to-end with a real LLM
against a real IDE.** Every LLM and IDE test to date used fakes
(`setMockClientOverride`, fake IDE drivers, `BUREAU_MOCK_LLM=true`).

Phase 7 is therefore **an expedition, not a build phase.** Most of the work is
*discovering what breaks* when real providers, real browsers, real git remotes,
and real latency/cost replace the fakes — then fixing the smallest thing that
unblocks the next step. Success is measured by a single supervised real run
reaching merge, plus an honest incident log of everything that broke on the way.

Because it is live, **real money and real git operations are in play.** Safety is
a first-class section below, not an afterthought.

## Exit sentence

> One real task, supervised, travels the whole pipeline — intake → plan → junior
> dispatch (real LLM driving a real IDE) → verify → senior review → operator
> approval (via the console) → PR → merge → backup — against a throwaway sandbox
> repo, with the watchdog and dashboards live the entire time, every budget and
> guardrail firing for real, and every incident recorded in
> `docs/phase-7-incidents.md`.

Demonstrated by the run itself (recorded journal + console screenshots/output)
and the incident log; not by a scripted demo.

---

## Safety posture (governs everything — read before touching a key)

1. **Sandbox target repo only.** The real task runs against a **throwaway git
   repo created for this purpose** — never a production repo, never the
   department's own repo, never anything whose history matters. `pr.create` /
   `pr.merge` / `backup.push` operate on *that* sandbox remote. Confirm the repo
   path/remote in D0-7 and nowhere else.
2. **Prefer local, free inference for the first run.** The LLM side supports
   **Ollama (local, no cost)** and **Google/Gemini (paid API key)**. Do the
   first end-to-end run on **Ollama** so the shakeout costs nothing. Only move to
   Gemini after the pipeline works locally, and only with explicit human sign-off
   on spend (see Operator decisions).
3. **Budget ceilings are real and enforced.** `plan_rounds`, `verify_fixes`,
   `cycles`, `attempts` already bound the loops. Before the first paid run,
   Stream A proves a run that would exceed a ceiling is **refused**, not silently
   continued. No unbounded retry against a paid endpoint.
4. **Keys in env only.** `GOOGLE_API_KEY` (and any Ollama host) come from the
   environment. Re-verify against a *real* key that no key reaches the DB,
   journal, spans, logs, PR bodies, or the console (the Phase 5 red-team suite +
   `redactOutput` are the guards; exercise them with a real value).
5. **Supervised, with a kill switch.** A human watches the run. Know how to stop
   it: Ctrl+C the runner, and `handle.close()` the console. The watchdog surfaces
   stranded state; do not leave a live run unattended.
6. **No production browsing/side effects.** The real IDE driver (CDP) drives a
   dedicated Chrome/IDE instance, not the operator's daily browser with logged-in
   sessions.

## Operator decisions to confirm with the human BEFORE D0-7

A fresh window **must** get these answered by the human (ask them — do not
assume; some cost real money):

- **Provider/model for the first run** — recommend local **Ollama** + a specific
  local model id (cost-free). Gemini only on explicit approval.
- **Sandbox repo** — which throwaway repo + remote the task runs against (offer
  to `git init` a fresh one under a temp/sandbox path).
- **Spend cap** — if Gemini is used at all, a hard budget ceiling and who approves
  crossing it.
- **The task itself** — a deliberately tiny, well-specified change (e.g. "add a
  function `add(a,b)` with a test") so the run exercises the pipeline, not the
  model's cleverness.

## Preconditions checklist (the running window verifies before D0-7)

- `npx vitest run` + `npm run build` green on `ba3ac1b` (or later `main`).
- LLM reachable: `npm run smoke:llm` lists real models (Ollama running, and/or
  `GOOGLE_API_KEY` set). A real call works with `SMOKE_TEST_CALL=1`.
- A Chrome/IDE instance the CDP client (`engine/harness/cdp-client.ts`) can attach
  to.
- A sandbox repo exists and is writable; its remote is a throwaway.

---

## D0-7 — Live harness freeze (do FIRST, before cutting streams)

One shared, reviewed configuration surface both streams depend on. Small commit,
Senior-verified, merged before A and B branch.

- A frozen **live-run config** (a checked-in `docs/phase-7-runbook.md` +
  whatever config/env the runner reads): chosen provider + model id, the real
  budget ceiling values, the sandbox repo path + remote, and the confirmation
  that `BUREAU_MOCK_LLM` is **unset** for live runs.
- A recorded **selector calibration snapshot** for the real IDE (Stream B
  depends on it; the calibration gate must pass on real selectors, not fakes).
- Confirm no new job kinds are needed (the pipeline already has them); grep,
  don't assume.
- Exit: build green, a config/runbook test if applicable, merged with a posted
  Senior verdict. Streams cut only after this is on `main`.

## Stream A — Junior A: Provider Reality
Branch `wt/junior-a-phase7`. Theme: the real model, attributed and bounded.

- **A1 — Real llm-seam wiring.** Drive `callModel` (`engine/llm/call_model.ts`)
  against the real provider end-to-end with **no mock override** and
  `BUREAU_MOCK_LLM` unset. A real `smoke:llm` call is recorded with real
  `tokensIn`/`tokensOut`/`latencyMs` written to the journal.
- **A2 — Fix the `[llm]` provider-doubling attribution bug.** The known cosmetic
  defect (`ollama/ollama`) in the dispatch→`callModel` attribution path
  (`engine/harness/dispatch-job.ts` provider default + `call_model.ts` span
  provider). A real journal span must read the provider once, correctly.
- **A3 — Budget enforcement under a real endpoint.** Prove a run that would
  exceed `plan_rounds`/`verify_fixes`/`attempts` is **refused** (guardrail span),
  not retried against the paid/live model. Re-verify key hygiene with a real key
  value (nothing secret in DB/journal/PR/console).

**Tests / evidence:** a live smoke call recorded (journal shows real tokens,
provider attributed once); a budget-ceiling refusal test (mutation: remove the
ceiling check → the run overspends); a key-hygiene test with a real-shaped
secret. Record in `docs/mutation-evidence-phase7.md`.

## Stream B — Junior B: IDE Reality
Branch `wt/junior-b-phase7`. Theme: a real editor, driven and correlated.

- **B1 — Real CdpIdeDriver.** Attach `engine/harness/cdp-client.ts` to a live
  Chrome/IDE; a real `read`/`act` round-trip works through the **calibrated**
  selector gate (`GatedIdeDriver`) — no fakes.
- **B2 — Real calibration.** Calibrate the selectors against the real UI so the
  gate passes on real selectors; the D0-7 snapshot is the frozen reference.
- **B3 — One real dispatch.** A real `junior.dispatch` produces a real file edit
  in the sandbox worktree, with **nonce triple-equality** (span detail =
  observation = driver echo) verified on the *real* driver, and **zero leaked
  browser processes** (the Phase 3 scar — verify teardown).

**Tests / evidence:** a recorded real dispatch (the edit lands, nonce matches,
no browser leak); reuse the Phase 3 process-leak check against the real driver.
Record mutations in `docs/mutation-evidence-phase7.md`.

## Convergence — C1: the supervised live run (the exit sentence)
Depends on A and B. Not parallelizable — this is the run itself.

With Ollama (free) + the sandbox repo + the real IDE, drive **one tiny real
task** from intake to merge: intake → plan → dispatch (A+B live) → verify →
senior review → operator approval **via the console** → `pr.create` →
`pr.merge` → `backup.push`, watchdog and dashboards live throughout. Capture the
journal, console output, and **every incident** in `docs/phase-7-incidents.md`
(this log is a primary deliverable — the point of the phase is to surface what
breaks). Only after the free run works end-to-end, optionally repeat on Gemini
with human spend approval.

---

## Coordination & sequencing
1. Human confirms the Operator decisions; window verifies preconditions.
2. Merge **D0-7** (config + calibration snapshot). Nothing else merges first.
3. Streams A and B cut from post-D0-7 `main`, run in parallel (A owns
   `engine/llm/**` + provider attribution; B owns `engine/harness/**` +
   calibration). Keep edits localized; whoever merges second rebases.
4. Converge at **C1**; the run + incident log is the exit evidence.
5. Merge law absolute: nothing reaches `main` without a posted Senior verdict for
   the exact commit. Any code fix discovered during C1 goes back through a
   milestone + mutation evidence, not smuggled into the run.

## Explicitly out of scope (defer to Phase 8)
Concurrency / many simultaneous tasks and windows; retiring `fileParallelism:false`
(orthogonal test-infra debt); provider cost optimization beyond basic token/cost
accounting; model-selection policy. Phase 7 is **one task, once, for real.**

## Definition of done
D0-7 + Streams A & B merged with posted Senior verdicts; suite + build green on
`main`; the C1 supervised run reaches merge against the sandbox repo on the free
(Ollama) path with the watchdog/console live; `docs/phase-7-incidents.md` records
what broke and how it was resolved; the `[llm]` provider-doubling bug is fixed;
the ledger updated by the Operator.
