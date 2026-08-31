# Pre-Phase-8 — what's left before concurrency at scale

Status: **2026-08-30/31.** Origin `main` has since advanced through five stream merges
+ the zai-capture harness fix (`…7163e72`; see N6 re: their missing verdict docs). The
Phase 8 *entry gate* (`docs/plan-phase8-entry.md`) is cleared, BUT the **first 2-concurrent
run this session proved concurrency is not yet safe** — juniors shared one window/chat and
contaminated each other (see the **2026-08-30 session findings** below, N0–N7). Read that
section first: N0 (completion race) and N3 (junior-B bypass) are the P0s that must land before
any honest ≥3-task run. Prior baseline (2026-08-28): fix pack F1–F6, Stream B provisioning
console (PR #2), the ZCode capture-race fix, department-resilience — all live. This doc is the
punch list before — and in the first steps of — **Phase 8 proper** (`docs/phase-8-plan.md`).

Priority: **P0** = do before declaring Phase 8 started · **P1** = do in the first
Phase-8 steps (will bite immediately at N tasks) · **P2** = hardening, opportunistic.

---

## 2026-08-30 session — findings from the first 2-concurrent run (NEW)

Two department-filed tasks ran overlapping (~18:54–19:19): `3756ec6e` ("hello marker",
Trading repo) and `b55e2fda` ("window-lease heartbeat", this repo — the P1.2 fix itself).
Both reached `needs-review`. The run was the first time two tasks moved through the flow
at once, and it exposed the gaps below. Every item here is journal-/git-verified in this
session, not inferred. **Verdict on the run:** seniors parallelized (claude + zai
concurrently); **juniors did not** — both tasks ran on junior A, one shared window/chat,
and contaminated each other. Concurrency is **not** proven yet.

Operator actions already taken this session (2026-08-30/31):
- **b55e2fda unblocked for delivery.** Its only gating `bureau_work_reviews` row was
  `phase='walkthrough'` at `9186a05`; the branch had advanced to `c126a68` (test-only
  fixes), so `pr.create` would have refused (`reviewed_commit != tip`). A real phase4
  **code-diff** senior review was recorded at `c126a68` (Claude Opus 4.8, verdict
  `docs/reviews/verdict-b55e-heartbeat-tip.md`; full suite 646/117 green at tip). Both
  tasks are now `needs-review` and pass every `pr.create` precondition — approve-ready.
- **3756ec6e** needed no fix (tip == reviewed `86cccba`, clean, `hello.txt`="hello trading").

### N0 — root cause: junior "completion" fires before the agent is done (P0)
`b55e2fda`'s `junior.dispatch` (`de0b4821`) was declared **complete at ~38s** while the
agent transcript ends with *"I have launched the initial vitest run to verify the baseline
before making any edits."* The agent then kept implementing **through** the senior review
and verify phases. This is the direct cause of the unreviewed post-approval edits (N1) and
a contributor to the contamination (N3). **Action:** dispatch completion must gate on the
agent genuinely finishing (idle + transcript stable AND evidence the requested work landed),
not the first idle read in a tool-call gap. Re-audit `waitForAgentIdle`/`requireActivityStart`
for the "agent paused on a long child-process run" case. This is the highest-value fix before
any concurrent run.

### N1 — verify-failure-sendback advances the branch past `reviewed_commit`, and the verify loop dispatches no fix (P0)
On `b55e2fda`, verify run 1 failed on genuinely broken tests (the new tests INSERT into
`bureau_meta (key,value,updated_at)` — no `updated_at` column exists). One second later the
`verify-failure-sendback` checkpoint (`c126a68`) committed fixes to exactly those tests —
**edits that came from the junior still working out-of-band (N0), not from any fix
mechanism.** Two defects:
- `engine/verify/loop.ts` `handleVerifyOutcome` just **re-enqueues `verify.run`** — there is
  no fix dispatch. "verify_fixes" is really "verify retries." A real verify failure with no
  lingering junior burns straight to `blocked`.
- The sendback checkpoint commits whatever is dirty in the worktree, so it can push the
  branch tip **past the senior-approved commit**, silently breaking the `pr.create`
  `reviewed_commit == tip` law. **Action:** either (a) verify-fix must be an explicit junior
  dispatch whose result is re-reviewed before the tip moves, or (b) if the checkpoint moves
  the tip, the flow must re-enter senior review (auto-enqueue `senior.review-work`) rather
  than land at `needs-review` with a stale verdict.

### N1 — status (2026-08-31): (b) DONE, (a) deferred behind N0
**Option (b) — stale-verdict hole — DONE** (branch `wt/n1-verify-sendback`, merged
local main). `handleVerifyOutcome`'s success path now refuses to reach `needs-review`
when the latest approved review's `reviewed_commit != tip` (a `verify-failure-sendback`
moved the tip past the approval): it transitions `verifying -> claimed`, enqueues
`work.cycle` to re-review at the new tip (idempotent), journals a
`verify_passed_stale_approval` guardrail, and notifies the operator. `tip` is read in
`verify/job.ts` before the finalization txn (best-effort; undefined disables the guard).
Mutation **M-N1**; suite 651/651 across 118 files. The retry/block budget (t25/t29
exit-sentence loop) is deliberately untouched — that bounded-retry-then-block-then-
operator-rearm is the honest fail-closed behaviour, not a defect.

**Option (a) — real verify-fix DISPATCH — DEFERRED behind N0 (still open, P0).** Today
the verify failure path re-enqueues `verify.run` with no junior fix dispatch, so
`verify_fixes` is a bounded RETRY budget, not a fix loop: an unattended real failure
retries identically to the ceiling then `blocked` (operator re-arm is the recovery). A
genuine auto-fix requires an explicit junior `junior.dispatch` fix round whose result is
re-reviewed before the tip moves — which is entangled with **N0** (the junior-completion
race is what currently makes the worktree dirty during verify at all). Sequence (a) AFTER
N0 lands: with N0 fixed, the worktree is clean at verify time, so the only way the tip
moves is a deliberate fix dispatch — at which point (a) can move the tip and re-review
safely, and the M-N1 guard already forces that re-review. Until then, verify failures
correctly escalate to the operator.

### N2 — the delivery gate can be a plan review, not a code-diff review (P1)
`pr.create` reads the **latest** `bureau_work_reviews` row `ORDER BY created_at DESC` **regardless
of `phase`**. `b55e2fda`'s gate was a `phase='walkthrough'` review of `implementation_plan.md`
— the final **diff** was never senior-reviewed before approval. **Action:** `pr.create` (and
the approve path) should require the latest **`phase='phase4'`** (work/diff) approved review at
the tip, not merely the latest review of any phase.

### N3 — junior B was bypassed; both tasks ran on junior A → cross-contamination (P0 for concurrency)
Deterministic `assignJunior(taskId)` would place `b55e2fda` on **B**, but all 8 dispatch
payloads carry `"junior":"A"` and target the shared `window-default` lease. The two tasks were
**time-sliced on one junior with one conversation**, so transcripts, plan artifacts, and even
the **hello task's implementation prompt (which embedded the heartbeat plan's "SENIOR'S FINAL
REQUIRED CHANGES")** were crossed. The claude senior's round-2 review caught it from the
artifacts; 3 of its 4 rounds on `3756` were contamination fallout. **Action:** find why B was
bypassed (likely `JUNIOR_DEFAULT=A` on the runner or a pinned rekick payload) — confirm B is
actually launched with its debug port and that `assignJunior` (not an env default) drives
selection under concurrency. This gates any honest ≥2-task run. Note: **b55e2fda's own fix
(per-junior window scoping `window-${junior}`) addresses the window half** once merged — but
the *assignment* half (which junior) must also be fixed, or both tasks still share A.

### N4 — two terminal plan-cycle failures needed an operator rekick (P1)
`b55e2fda` died on *"prompt did not land in chat input"*; `3756` died twice on *"workbench
window did not become available"*. `max_attempts:1` makes each terminal; WS2 auto-recover did
not prevent it → **human rekick ×2** at 18:54. Ties to the cold-start attach budget already
noted in memory (`antigravity-coldstart-attach-fix`). **Action:** confirm the cold-start attach
budget fix is live on the runner, and decide whether plan.cycle should get a bounded auto-retry
(it currently doesn't, by the "failed cycles are operator action" rule).

### N5 — long dead stall + dirty-worktree-continue (P2)
- `b55e2fda`'s `plan.cycle` sat **queued 15:55→18:30 (2h35m)** with no runner draining it.
  Reconciler/heartbeat gap or the runner was simply down — confirm a runner is always draining.
- `3756` round 2 hit `junior_worktree_prepare_failed` (worktree dirty) yet the dispatch
  **continued anyway** without the prepare step. Prepare failure should hard-stop the dispatch.

### N6 — six evening merges landed with no posted verdict docs (process, P1)
Streams 1–5 + the zai-capture fix (`4d04abf`…`b24c516`, `7163e72`) reached `main` **and
origin** with **no `docs/reviews/verdict-*.md`**; the stream walkthroughs still literally say
*"NOT merged — awaiting senior verdict,"* and there are **zero journal spans 19:20–21:30**.
Review evidence is an inline commit-message claim + a Claude co-author trailer. This is the
same "engine-development merges bypass the flow" tension as the standing scar. **Action:** the
operator decides — ratify these as sanctioned engine-dev merges (and note it), or require
retroactive verdict docs. Then resolve the standing policy (see P2 §2.1) so it stops recurring.

### N8 — pr.create runs `gh` in the wrong repo for non-dept projects (P0, proven 2026-08-31) — ✅ DONE (2026-08-31, merged local main `4e1bbdd`)
**Fixed.** `PrProvider.createPr`/`mergePr` gained an optional `cwd`; `GhCliPrProvider`
forwards it (defaulting `cwd ?? this.repoRoot`); `pr_create.ts` threads `wtRow?.path` into
`createPr` and `pr_merge.ts` looks up the worktree (present pre-prune) and threads it into
`mergePr`. `FakePrProvider` records the cwds; t43/t44 assert the worktree path flows through
create AND merge. Mutation **M-N8** recorded (`docs/mutation-evidence-phase8.md`). Suite
646/646 across 117 files (green on the branch and on merged main; one intermittent
parallel-load flake on unrelated t41 seen once, cleared on re-run). claude senior **APPROVE**
(`docs/reviews/verdict-n8-pr-gh-cwd.md`), merged `--no-ff` to local main `4e1bbdd` (not
pushed — origin push is the operator's call). The senior surfaced the adjacent **N9** below.

### N9 — backup.push runs in the dept repo for non-dept tasks (P0, senior-found 2026-08-31) — ✅ DONE (2026-08-31, merged local main)
**Fixed.** `getBackupProvider(repoRoot?)` now roots the `ExecGitBackupProvider` at a
caller-supplied repo (default: dept tree); `backup_push.ts` resolves the task's
`bureau_projects.path_to_repo` (via `task.project_id`) and passes it, so a non-dept
task's fetch/ff-only/containment/push run against that project's repo + remote.
Mutation **M-N9** (both resolution + seam, proven safely via a `getBackupProvider`
spy so no test can run `git push` on the live dept repo). Suite 654/654 across 120
files. **Scar recorded:** an earlier draft's integration mutation ran the real
fallthrough `git push origin main` against the live dept repo (fast-forwarded
origin/main to the N8+N1 tip early — benign but unintended); the test was redesigned
to spy the seam. Original diagnosis below.


Same class as N8, one layer down. `engine/durability/git_backup_provider.ts` /
`backup_push.ts` always run in `this.repoRoot` (the dept repo) with **no cwd threading**,
and `pr_merge.ts` unconditionally enqueues a `backup.push` after **every** merge (non-dept
tasks included). So for a non-dept task the backup's containment-check (`git` fetch/rev-parse
to prove the remote already contains the merge commit) and any fast-forward push run against
the **dept** repo's `origin/main`, not the task's project repo — the check reads the wrong
remote. Pre-existing, untouched by N8, surfaced by the claude senior during the N8 review.
**Action:** thread the task's worktree/project repo path into the backup provider the same
way N8 did for the PR seam (or make `backup.push` project-aware from `bureau_projects`), and
decide whether a non-dept merge should even target the dept's `origin/main` at all. Add
regression coverage mirroring M-N8. Blocks honest delivery-tail draining for non-dept
projects (N8 unblocks `gh`; N9 unblocks the backup that runs right after).
On approval, `3756ec6e` (Trading project) delivered its branch push fine but **`gh pr create`
failed 3× → dead**: *"No commits between main and bureau-wt-3756…, Head ref must be a branch."*
Root cause: [pr_create.ts](../engine/delivery/pr_create.ts) passes the worktree path to
`pushBranch(refspec, wtRow?.path)` but **not** to `createPr({...})` — so `gh pr create` executes
in the **dept repo's cwd** and targets `department-of-codeV2`, where `bureau-wt-3756…` doesn't
exist. b55e2fda (a task *in the dept repo*) delivered fine precisely because its worktree's repo
IS the dept repo, which masked the bug. **This blocks delivery for every project except the dept
itself.** **Action:** thread the project repo path (the worktree's git dir / the
`bureau_projects.path_to_repo`) into `getPrProvider().createPr` and run `gh` there, the same way
`pushBranch` already does. Operator worked around it this session by fast-forwarding the reviewed
`86cccba` onto Trading `main` and pushing (task was completed-tagged; its `completion_commit` in
the DB is still `null` — cosmetic).

### N7 — housekeeping (P2)
- **Stale ledger:** `docs/DEPARTMENT_STATUS.md` didn't reflect this session — updated now.
- **`implementation_plan.md` written into the primary checkout on `main`** (untracked) — the
  junior's plan said "work directly on main"; the dispatch had to override. Keep junior scratch
  out of the primary tree.
- **Orphan needs-review task `live-mt0xgoxz`** ("Add subtract() to math.js", `project_id=null`)
  — a leftover test artifact sitting in `needs-review`. Archive or Complete-tag it; don't let it
  masquerade as real delivery-ready work.

### Suggested order for tomorrow
1. Approve `3756ec6e` and `b55e2fda` in the console (both are ready). Merging b55e2fda buys the
   **per-junior window** half of the concurrency fix.
2. **N0 + N3** before any ≥2-task run — the completion race and the junior-B bypass are what
   made this run contaminate itself. Without them, concurrency will fail the same way at higher N.
3. **N1/N2** — close the verify-sendback / stale-verdict hole (this is why b55e2fda needed a
   manual re-review; it must not recur unattended).
4. Decide **N6** (ratify vs. retro verdicts) and resolve the merge-law policy (§2.1).
5. Then, and only then, the ≥3-concurrent load run that actually starts Phase 8 (see bottom).

---

## P0 — clear the last entry-gate item

### 0.1 Supervised provisioning convergence (entry-gate step 3) — NOT yet run
The only entry-gate step still open. File a real "create new project" task through
the now-complete console (Projects → Create new → provision), and watch it run the
live path end-to-end against a real GitHub repo: `POST /api/projects/provision` →
`project.provision` job → `gh repo create` → register → `project-provisioned`.
Supervise it (`gh auth status` green first). Success criterion: a real repo created +
registered, the chip resolves to done, zero hand-repairs. This is the last "prove the
tail drains itself" gate before scaling.

---

## P1 — will bite immediately at N concurrent tasks (do early in Phase 8)

### 1.1 Senior throughput at scale — the single ZCode instance is a hard bottleneck
The new single-instance **mutex (WS4b)** serializes all zai/ZCode reviews: at N
concurrent tasks their senior reviews queue one-at-a-time on that lock. The **claude**
senior is a subprocess and parallelizes freely (and now has the adaptive stall/cap
timeout, so long reviews aren't cut off). **Action:** make the assignment policy
scale-aware — default plan+walkthrough reviews to **claude** under concurrency, keep
zai for single-stream / when claude quota is tight; document the split in
`docs/senior-integration.md`. (Also: zai's Z.ai account hit its 5-hour quota this
session — another reason not to make it the critical path at scale.)

### 1.2 Window-lease heartbeat for long GUI dispatches
Known wart (ledger): a long `junior.dispatch` always gets its 2-minute
`window-default` lease reaped (`heartbeats: 0`, no renewal path) — harmless with one
dispatch, but at N concurrent juniors a reaped lease can let a second dispatch grab a
window mid-run. **Action:** renew the window lease on a heartbeat while a dispatch is
active (mirror the job heartbeat), or scope leases per junior (A/B/…).

### 1.3 Prove the wedge/down auto-recovery under real contention
WS1/WS2 (auto-restart a downed senior / wedged junior) are unit-proven but only
lightly exercised live. In the first concurrent run, deliberately kill a junior/senior
mid-flight and confirm the flow self-heals and continues (don't wait for a real
outage to discover a gap).

### 1.4 Verify the delivery-branch model holds at N (S3 / F3)
F3 aligned the junior's `wt/…` branch with the `bureau-wt-<taskId>` delivery branch.
Confirm this holds when several worktrees exist at once (no cross-task branch collision
in `pr.create`).

---

## P2 — hardening / debt (opportunistic)

### 2.1 A1 merge-law git hooks are NOT installed in-repo (policy tension)
`npm run hooks:install` exists but is intentionally uninstalled — it would block the
department's OWN engine-development merges. Resolve the policy: e.g. an allowlist / a
`BUREAU_MERGE_LAW_BYPASS` for human engine-dev commits while enforcing the law for
flow-driven merges. Until resolved, the merge law is convention, not enforcement.

### 2.2 Intake `acceptance_tests` D0 addendum
Add the `bureau_intake_sessions.acceptance_tests` column so the A3 staged verifier can
consume drafted acceptance tests from intake (the verifier already reads
`task.acceptance_tests`; the intake side doesn't draft them yet).

### 2.3 Resilience follow-ups (from the WS review, `docs/reviews/verdict-dept-resilience.md`)
- WS4a: a few rotating template-card phrases remain as home-screen markers — harmless
  today (needs ≥2 markers AND no VERDICT line), but re-verify if the ZCode empty-screen
  copy changes again.
- WS4b: `removeLockIfOurs` has a tiny read-then-unlink TOCTOU window — fine on one host.
- `killProcessesByImageName` uses `pkill -f` off-Windows, which can over-match — tighten
  if the department ever runs on POSIX (Windows uses `taskkill /IM`, exact).

### 2.4 A5 pricing (operational, not code)
Unset model prices report an honest "unpriced floor" (`npm run cost:report`). Set real
prices via `setModelPrice`/meta when cost accounting matters at scale.

### 2.5 Journal legibility & depth — the ledger reads like machine exhaust, not a record
**Problem (observed).** The department's core law is "every act is a tracked, attributed,
journaled thing," but the journal itself is hard for a human to read. Three concrete gaps:

- **"Weird sentences."** `detail` is a machine object (`{fromState, toState}`,
  `{action:'work_review_no_walkthrough'}`, `{stage:'plan-review', senior, verdict, planId}`)
  and the console dumps it **raw** — `renderJournalTimeline` prints `escapeHtml(j.detail)`
  (`console/public/render.js:662`). So the operator sees a JSON blob or a terse snake_case
  token, not a sentence. There is **no narration layer** anywhere.
- **"Very brief records."** Detail carries only the minimum keys a machine needs; there is
  no human-facing `summary`, no "what/why/outcome" context. Two rows with the same `kind`
  are indistinguishable without decoding their JSON.
- **"Time not recorded properly."** Each row stores `ts` as raw ISO and the console renders
  it raw (`timeline-ts` = `${j.ts}`) — no local/relative formatting, no per-group time span.
  More fundamentally, rows are **point events despite the `journal`/`SpanKind` "span"
  naming**: there is no start→end pairing or **elapsed duration** for a plan review, a
  dispatch, or a job — only per-model-call `latency_ms`. You can't read "the plan review took
  6m 12s" from the ledger.

**Invariant to preserve (do NOT break).** `bureau_journal` is append-only (two triggers,
`schema.ts:104-108`) and attribution-validated through the single `journal()` door
(`engine/journal/writer.ts`). **Do not write prose into the immutable store** and do not
loosen validation. Narration is a *derived/rendering* concern; depth is added as
*structured* fields, not free text baked into history.

**Action (three layers, smallest-blast-radius first):**
1. **Narration layer (rendering-only, no schema change).** Add a pure
   `narrateEntry(row): string` (e.g. `engine/journal/narrate.ts`) that maps a structured
   row → one natural-language sentence, keyed on `kind` + `detail.action`/`stage`
   ("The plan senior (claude) approved the plan for *&lt;title&gt;* — 12.3k tokens, 47s.").
   Consume it in `renderJournalTimeline` (console) and any CLI/digest that prints the
   journal, with the raw JSON kept behind a details/expand toggle. Unit-test the mapping.
2. **Time rendering.** Render `ts` as absolute **local** time + a relative hint
   ("2m ago"); show a per-group time span (first→last) and, where a row carries
   `latency_ms`, surface it as human duration. Pure formatting helpers, unit-tested.
3. **Depth at write-time (structured, opt-in).** Standardize `detail` keys per `kind`
   (always an `action`, an `outcome`, and a short human `summary` string authored by the
   caller) and, for long-running acts, pair a start row with an end row (or add
   `duration_ms` to the terminal row) so elapsed time is a first-class fact, not inferred.
   Roll out call-site by call-site; the narrator falls back to the generic mapping for
   rows that predate the richer detail.

Scope note: layers 1–2 are self-contained and low-risk (no DB migration, no law change) —
worth doing opportunistically. Layer 3 touches many call sites; sequence it after Phase 8
concurrency is stable unless the operator wants the deeper record sooner.

---

## Definition of "Phase 8 has started"
Origin main green + pushed (**done**), the supervised convergence run proven (0.1),
and the first **≥3 concurrent tasks** driven through intake→plan→implement→verify→
review→merge with the tail draining itself and no per-merge hand-repair. Then the
work moves to `docs/phase-8-plan.md` proper: Secretary, lease contention, and the
watchdog under sustained multi-task load.
