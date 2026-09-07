# Dead-dispatch salvage & containment — incident C-series (2026-09-06)

Status: **2026-09-06.** This plan records the diagnosis of the 2026-09-04
task-filing incident (both filed tasks appeared to "fail horribly") and the
fixes that keep the failure class from recurring. It was written at the
operator's request the same session the incident's damage was recovered
(Track 1 salvage, see §3). The fixes below are the work items — file them
one at a time through the agent door, as ordinary engine-dev tasks, in the
order given. Numbering is **C1–C5** (Containment series) to avoid colliding
with the N-series in `docs/plan-pre-phase8-remaining.md`.

Priority: **P0** = the incident's direct enablers · **P1** = bites under any
repetition · **P2** = hygiene.

---

## 1. Incident diagnosis — what actually happened on 2026-09-04

Two tasks were filed through the agent door at 03:30Z by a zai session
(attribution `senior-engineer/zai`):

- `81b5a1ee` "Console Workers tab: one-click Resume" (junior B, senior zai)
- `05c6edc0` "Journal completeness" (junior A, senior claude)

**`81b5a1ee` did not fail.** It ran the full pipeline — 4 plan rounds
(2 zai amends, both concrete and spec-grounded; 1 rubric amend; approve),
implementation (~795 insertions), 1 walkthrough amend, approve, verify-failure
sendback, verify-fix, verify exit 0 — and reached `needs-review`. The zai
senior's direction was accurate throughout (it caught, e.g., that
"re-enqueue under new UUID" abandons the deterministic job-id scheme the
spec mandates). The operator-facing sense that "senior zai can't direct its
suggestions" is **not supported by this run**. The real zai-driver defects
found are cosmetic-but-real capture issues (C5).

**`05c6edc0` failed through a four-defect cascade**, none of which involve
the zai senior (claude reviewed its plan):

1. **Junior A's CDP link died mid-dispatch (the standing 2026-09-03 blocker,
   still unfixed).** All 3 `junior.dispatch` attempts failed (`cdp http
   timeout`, `CDP timeout: Runtime.evaluate` ×2); job dead at 3/3, 03:52:53Z;
   task stranded at `claimed` with a dead job.
2. **The junior was alive and working the entire time.** Attempt 2 had
   delivered the prompt; the agent worked 03:42–04:36Z — 44 minutes past
   its own death notice — finishing a complete implementation (15 files,
   +259/−24 in the worktree), a new integration test, and a final
   walkthrough in its brain transcript
   (`~/.gemini/antigravity-ide/brain/f6dc96d8-…`). The department captured
   none of it. Attempt 3's `worktree.prepare` even refused with
   *"worktree is dirty; refusing to reuse or force-delete"* — the system
   SAW the work and treated it as an error.
3. **The junior's approved plan linked primary-repo paths**
   (`d:/Dept of code v2/engine/…`, not the worktree). Following its plan,
   the agent edited BOTH its worktree (complete set) AND the main checkout
   (a partial, independently-authored second copy, 9 files) — the N16 leak
   class, undetected because the primary-clean check never runs after a
   dead dispatch. Its `npx vitest run` from the primary root then polluted
   `docs/junior-artifacts/` with 11 fake-task dirs (8 more in the worktree).
4. **The artifacts pollution is a production bug, not just junior sloppiness:**
   `artifactsRoot()` in `engine/harness/junior-artifacts.ts` defaults to
   `process.cwd()`, so ANY test (or junior) exercising the artifact writer
   from a repo root writes junk into the real artifacts dir.

Net effect visible to the operator: one task stuck at `claimed`, main's
tree dirty with unreviewed code, 19 junk dirs — "filed tasks failed
horribly" — while the actual work product was ~95% complete and recoverable.

## 2. Why the flow let it happen (mechanism gaps)

- **A dead dispatch strands silently.** Nothing reconciles "dispatch died"
  with "worktree has changes newer than dispatch start" or "the junior's
  brain transcript has a walkthrough after dispatch start". The task sits
  at `claimed` until a human notices (this incident: 2 days).
- **Admission ignores junior health.** The task was filed into junior A
  while the ledger's own Next-action said Antigravity was down/unstable.
  The queue manager checks capacity, not liveness.
- **Plan review doesn't check path discipline.** The rubric checks
  branch/scope/walkthrough presence; neither it nor the senior caught that
  the plan's file targets lived in the primary checkout.
- **CDP timeout means "lost the window", not "the agent died"** — but the
  job semantics treat it as terminal death with no salvage path.

## 3. What was already done (2026-09-06, Track 1 recovery)

- Salvage verified and committed on the delivery branch:
  `b83bb53` on `bureau-wt-05c6edc0-…` (tsc clean; suite **790/790**, the
  two earlier failures were the known parallel-load flake classes, green in
  isolation). Salvage provenance recorded in the task's artifact dir
  (`docs/junior-artifacts/05c6edc0-…/2bbb2c50-…-juniorA-2026-09-04T04-36-04-000Z/`).
- The junior's partial second copy in the primary checkout was reverted;
  main's tree is clean at `0011827`.
- 26 fake artifact dirs removed from both trees (untracked junk only; the
  tracked `clicker-test-2026-08-20` dir was caught by the restore check —
  see the session note in the ledger).
- `work.cycle` enqueued through the engine's own `enqueueJob` with a
  `dead_dispatch_salvage_rekick` journal span; the assigned claude senior
  reviewed the salvaged tip and returned a substantive **AMEND** (the
  narration for the new *dispatch-phase* branches — `verify-fix`,
  `work-review-fix`, `plan-authoring` — was dead code: no producer set
  `stage` for those, though the review-stage producers already do; the
  tests hand-construct shapes and mask the gap). The
  fix dispatch was auto-enqueued and junior A (auto-relaunched by the
  harness) was implementing it at time of writing.

## 4. The fixes (file as engine-dev tasks, in this order)

### C1 (P0) — dead-dispatch work reconciliation ("the salvage detector")
**Problem:** a terminally-dead `junior.dispatch` strands the task at
`claimed` even when the junior kept working and produced a finishable
result. Nobody is told; nothing is journaled; recovery requires forensics.
**Change:** when `junior.dispatch` exhausts attempts, before giving up:
snapshot the worktree's dirty set + mtimes and check the junior's brain
dir for artifacts newer than dispatch start. **The brain path is
provider-specific** (Antigravity: `~/.gemini/antigravity-ide/brain/…`) —
expose it through a provider seam (e.g. `juniorProvider.brainDir(junior)`)
that returns `null` for providers without one, so the detector degrades to
the worktree-dirty signal alone rather than silently no-op'ing on a
non-Antigravity junior. If work is detected: (i) **capture the junior's
brain transcript into the task's artifact dir** (`docs/junior-artifacts/
<taskId>/…`) so salvage is a one-command act instead of a manual forensic
dig — the empty scratch file in THIS incident is exactly the gap; (ii)
journal a `dead_dispatch_work_detected` guardrail span; (iii) notify the
operator via the existing ntfy catalog (`blocked` state class); (iv)
transition the task to `blocked` (operator-action) instead of leaving it
at `claimed` with a dead job. Do NOT auto-salvage — the operator (or an
operator-side session at the operator's direction) performs the salvage,
as happened here, so every salvage stays a tracked, attributed act.
**Acceptance:** integration test — a fake dispatch dies terminally after
the fake junior dirtied the worktree → task lands `blocked`, span exists,
transcript captured under the artifact dir, notification fired; a clean
death (no work) leaves today's behavior; a provider with no brain seam
still blocks on the worktree-dirty signal alone.
**Mutation:** drop the reconciliation call → task strands silently, test
fails.

### C2 (P0) — artifacts root containment
**Problem:** `writeJuniorArtifacts`/`readLatestArtifacts` resolve their
root from `process.cwd()`. Any test or junior running the suite from a
repo root materializes fake task dirs under the real
`docs/junior-artifacts/` (19 junk dirs in this incident), and a junior
running tests in the WRONG tree can even satisfy artifact reads for the
right one.
**Change:** thread the artifacts base explicitly — the task's repo root
(from the workspace provider / `getTaskRepoRoot`), with `process.cwd()`
only as an explicitly-commented last resort for the CLI paths; add an
override seam (env or parameter) and point `tc_journal_completeness` at
its temp dir; add a guard test asserting a full-suite-shaped run creates
NO new dirs under the real `docs/junior-artifacts/`.
**Acceptance:** running the suite from either repo root leaves
`docs/junior-artifacts/` byte-identical (guard test proves it).
**Mutation:** revert the seam to cwd-only → guard test fails by finding
junk dirs.

### C3 (P1) — junior health gates at admission
**Problem:** tasks are admitted and dispatched into juniors that are down
or CDP-unstable (the standing Antigravity blocker). Each failure burns
3 attempts × window-wait and strands a task.
**Change:** (a) the queue manager probes the pinned junior before admitting
a task — **a real CDP handshake, NOT a bare TCP connect.** This incident
was a *port-open-but-CDP-dead* failure (`CDP timeout: Runtime.evaluate`,
the `isJuniorWedgedWindowError` class in `dispatch-job.ts`); a TCP check
would have returned healthy and admitted the task straight into the wedged
window. Reuse the existing wedged-detection path: a cheap `Runtime.evaluate`
round-trip with a short budget, healthy only on a real echo.
(b) a `junior.dispatch` terminal failure of the CDP-timeout/wedged class
marks the junior unhealthy in memory/meta with a cooldown — new admissions
for that junior wait instead of piling in; (c) `ensureJuniorRunning`'s
auto-relaunch success clears the flag (proven live twice now: Sept 4 plan
authoring, Sept 6 fix dispatch).
**Acceptance:** unit tests on the admission predicate; integration test —
CDP handshake times out (port open, no echo) → task stays `queued`, journal
span `junior_unhealthy_hold`; handshake echoes → admitted.
**Mutation:** replace the handshake with a TCP-only check → the wedged-junior
test admits against a dead CDP and fails.

### C4 (P1) — plan path discipline + primary guard on failed dispatches
**Problem:** an approved plan can target primary-checkout paths; the junior
then edits main's tree (this incident: 9 files). The N16 primary-tree guard
only runs on dispatch COMPLETION — a dead dispatch never checks, so the
leak landed silently.
**Change:** (a) plan rubric rejects plans whose file paths resolve outside
the task worktree (the rubric already parses branch/scope; add path
scoping); (b) the primary-baseline check runs in the dispatch failure path
too (attempt-exhausted), not only on success; (c) the implementation
prompt already pins the worktree — keep F2's self-contained preamble and
add one explicit line: "Edit ONLY files under <abs worktree path>".
**Acceptance:** rubric test (plan with a primary path → amend); dispatch
failure test (junior dirtied primary during a dying dispatch → guardrail
span + operator notification).
**Mutations:** remove either check → corresponding test fails.

### C5 (P2) — zai senior capture hygiene + verdict vocabulary
**Problem:** (a) every zai review captured on 2026-09-04 begins with a
literal `Copy` / `Edit` line — the harness is capturing ZCode UI hover
chrome as review text, mildly corrupting the department's permanent
record; (b) the zai senior emits `VERDICT: REVISE` where the flow's
vocabulary is `AMEND` — parsing maps it, but `narrateEntry` needed an ad-hoc
branch (the salvaged task patches it; centralize instead).
**Change:** strip leading UI-chrome lines in the senior reply extraction
(pure function + unit test with the 2026-09-04 captured text as fixture);
centralize the REVISE→amend synonym mapping next to `parseVerdict` so
narration and review rows share one vocabulary.
**Acceptance:** unit tests for both; a captured 2026-09-04 review round-trips
clean.
**Mutation:** remove the strip → fixture test fails.

## 5. Sequencing

One task at a time (current law until Phase 8 proper): **C2 first** (small,
pure hygiene, unblocks trusting the artifacts tree), then **C1** (the
incident's core), then C4, C3, C5. C1 and C4 touch the same dispatch
failure path — land C1, rebase C4 on it. The standing Antigravity CDP
investigation (ledger 2026-09-03 blocker) remains the environment P0
above all of these; C3 is the engine-side mitigation while it stays open.
