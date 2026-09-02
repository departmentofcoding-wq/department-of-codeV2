# Plan — Junior-B run fix pack (from the 2026-09-02 N9 rekick)

Status: **authored 2026-09-02** after the first live delivery run through junior B
(Antigravity 2.0), task N9 `693ad95a`. The B single-window delivery fix
(`796e6ac`) WORKED — B implemented the refactor in the worktree (`backup_push.ts`
+ two test files, intact in `.bureau-worktrees/693ad95a…`). Three separate
defects, surfaced by that run, are captured here as individual fixes. This doc is
untracked (operator's call to commit).

## What the run proved and exposed

- **PROVEN:** junior B reaches its worktree via the main-window + injected
  `WORKING DIRECTORY` directive and edits the right files. The delivery path is
  correct.
- **DEFECT 1 (blocker):** N9's dispatch was FAILED by the N16 primary-tree guard,
  which flagged `docs/DEPARTMENT_STATUS.md` — an operator's *pre-existing*
  uncommitted ledger edit, not the junior's doing. The guard blames the dispatch
  for ANY tracked-dirty primary path; it never baselines the pre-dispatch state.
- **DEFECT 2:** across a mid-flow junior-B restart (recovery), the implementation
  dispatch lost the planning conversation and re-ran with no prior context,
  wasting tokens (B is single-window / multi-conversation; "continue the current
  conversation" is ambiguous after a restart).
- **DEFECT 3:** the wedged-junior recovery only fires on the "no CDP window /
  workbench did not become available" class; the "port dead + single-instance
  lock" class ("launched but no CDP endpoint on port N within timeout") is NOT
  auto-recovered, so it burned two dispatch attempts and needed a manual
  kill-all + relaunch-with-port.

## F1 — N16 guard must baseline the pre-dispatch dirty set (BLOCKER)

**File:** `engine/harness/dispatch-job.ts` (the N16 block, ~line 341) +
`engine/worktrees/primary_guard.ts`.

**Problem:** `inspectPrimaryTree` returns the ABSOLUTE set of tracked-dirty paths;
the dispatch handler treats a non-empty set as contamination. A file the operator
left uncommitted before the dispatch (the ledger, an in-progress edit) is
therefore falsely attributed to the junior and fails an innocent run — and blocks
EVERY worktree dispatch until the tree is clean.

**Fix:** snapshot the primary tree's tracked-dirty set (and ideally per-path
content hashes/oids) at dispatch START, before driving the junior; after the
dispatch, flag only paths that are NEWLY dirty or whose content CHANGED during the
run (set/oid difference). Pre-existing dirt is ignored. Keep it fail-loud on a
genuine new leak (the 0e921cfa scar). Add `inspectPrimaryTree` a baseline
parameter or a `diffPrimaryTree(before, after)` helper; the guard compares.

**Tests:** (a) pre-existing dirty tracked file present at start + junior edits
ONLY the worktree → guard passes (the N9 false-positive, now green); (b) junior
also dirties a NEW tracked primary path → still fails loud (0e921cfa preserved);
(c) a pre-existing dirty file whose content the dispatch FURTHER changes → flagged.
Mutation: revert to absolute-set check → test (a) fails.

## F2 — single-window junior conversation continuity

**File:** `engine/harness/antigravity-seam.ts` / `antigravity.ts`
(`newConversation`, the `freshConversation` handling), scoped to
`windowModel: 'single-window'`.

**Problem:** for junior B the plan is authored in one conversation; the
implementation dispatch (`freshConversation:false`) is meant to CONTINUE it, but
after a restart the active conversation is blank, so context is lost and tokens
are wasted re-establishing it. The implementation prompt does embed the approved
plan, but B still re-explores.

**Fix (pick the robust one during implementation, prove live):** give a
single-window junior a stable per-task conversation handle — e.g. name/select the
task's conversation (B lists conversations by title; the run titled it "Refactor
Backup Push Repo Root") and re-open it across phases and across a restart, so
plan→implement→fix rounds share one conversation. If reliable conversation
re-selection is not achievable via CDP, fall back to making each phase's prompt
fully self-contained AND suppress redundant re-exploration (the plan already
carries the file list). Must not regress junior A (folder-window) behavior.

**Tests:** unit-level selection/logic where pure; a live run is the real proof
(the rekick). Journal the conversation handle used per dispatch for auditability.

## F3 — recover the "port dead + single-instance lock" wedge class

**File:** `engine/harness/antigravity.ts` (`isJuniorWedgedWindowError` /
`ensureJuniorRunning`) + `dispatch-job.ts`
(`runJuniorCommandWithWedgedRecovery`).

**Problem:** when a junior's CDP port dies while its app processes still hold the
single-instance lock, `ensureJuniorRunning`'s relaunch just forwards to the
wedged instance and times out ("launched but no CDP endpoint on port N within
timeout"). This class is not matched by `isJuniorWedgedWindowError`, so it is not
auto-recovered — it burned two N9 attempts and required a manual
`taskkill /IM Antigravity.exe /F` + relaunch-with-port.

**Fix:** recognize the port-timeout failure as a wedge class and route it through
`recoverJuniorRunning` (unconditional kill-ALL of the junior's processes +
relaunch WITH `--remote-debugging-port`, then wait for the port). Guard it so a
genuinely-absent install still fails loud rather than looping. Cap the recovery
so it cannot thrash.

**Tests:** a fake port-prober that reports the port dead + a fake killer/spawner →
recovery kills then relaunches then the port comes up → run proceeds; mutation:
drop the port-class from the recovery trigger → the port-timeout burns all
attempts (the N9 behavior).

## Ordering / gating

- **F1 lands FIRST** — it is the blocker: until it lands (or the primary tree is
  committed clean), every worktree dispatch false-fails the same way, wasting
  junior runs and tokens. F1 is a contained engine change; recommend engine-dev
  (branch → claude-senior review → merge) like the other N-fixes, or a filed task
  guarded behind a clean tree.
- **F2, F3** can follow independently.
- Junior B's N9 work is already sitting in `.bureau-worktrees/693ad95a…`; once F1
  lands (or the tree is clean), N9 can be re-driven / its worktree salvaged
  instead of re-implemented.
