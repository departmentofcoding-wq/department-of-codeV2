# Senior verdict — A1 — merge-law git hook + delivery-tail regression lock

**Senior:** claude (Claude CLI, headless)
**Branch:** wt/a1-reconciliation-mergehook
**Verdict:** REVISE

---

**VERDICT: REVISE**

## Summary

The unit/integration tests are real (t45 drains the actual job queue through `approveTask`, no direct state writes; `tc_merge_guard` mutation on `reviewed_commit` is a legitimate regression lock), and the predicate in `engine/delivery/merge_guard.ts` is sound and injection-safe. But the git-hook layer has a bypass that defeats the literal task spec ("refuse out-of-band merges to main"), and the walkthrough's live-proof claim doesn't cover it.

## Finding (CONFIRMED)

**A fast-forward merge into `main` bypasses the guard entirely — no hook fires.**

- `scripts/install_git_hooks.ts:69` sets `git config merge.ff false` as the only mitigation for this.
- `git merge --ff-only <branch>` or `git merge --ff <branch>` (or `git pull` without `--no-ff`) both **override that config on the command line**, and when a fast-forward is possible, git advances the `main` ref directly with **no new commit object and no hook invocation** — `pre-merge-commit` and `pre-commit` never run.
- Failure scenario: an operator on `main` runs `git merge --ff-only wt/some-stream` (exactly the muscle-memory move behind the 2026-08-24 scar this stream exists to prevent). If a fast-forward is possible, `main` advances to an unreviewed, undelivered tip with zero refusal, zero journal entry, zero trace — the precise failure mode the task asked to close.
- `scripts/merge_guard_hook.ts:22-24` documents this only as "a fast-forward merge creates no commit and runs no hook," framed alongside the benign `git pull` fast-forward case, not called out as a full bypass of the stated guarantee.
- Claim 4 in the walkthrough ("the hook refuses out-of-band merges — proven live") was only demonstrated with `git merge --no-ff`. It was never tested against `--ff`/`--ff-only`, so the claim is broader than what was actually proven.

This isn't unfixable with git hooks — a `reference-transaction` hook (fires on *any* ref update, including fast-forwards) could close this gap, unlike `pre-merge-commit`/`pre-commit`. That wasn't attempted here.

## Secondary (informational, not blocking)

`engine/delivery/merge_guard.ts:16-17`'s comment claims "the done-gate CHECK has already required verifier exit 0 + operator approval before merged_at can be written." The actual DB `CHECK` constraint (`engine/db/schema.ts:40`) only enforces `merged_at IS NULL OR state = 'done'` — the verifier/approval gating is application-level (`transition`/`approveTask`), not a schema constraint. Pre-existing code, not touched by this stream, and the done-gate itself is confirmed untouched — just a slightly overstated comment, not a defect.

## Recommendation

Before merging: either (a) add a `reference-transaction` hook (or equivalent) that also refuses fast-forward ref updates on `main`, or (b) if that's deferred to a follow-up stream, the walkthrough must say plainly that fast-forward merges are an **open, unmitigated bypass** of the merge law — not bury it as a footnote next to the harmless `git pull` case, and narrow claim 4 to "refuses non-fast-forward local merges." The done-gate and delivery-tail regression lock (T45, M-MERGE-1) are solid and can stand; it's specifically the "refuses out-of-band merges" claim that needs to match what was actually built.


---

## Resolution (round 1 → fix)

REVISE addressed: added a **reference-transaction** git hook
(`runReferenceTransactionGuard` / `decideRefUpdate` in
`scripts/merge_guard_hook.ts`, installed by `install_git_hooks.ts`) that fires on
any update to `refs/heads/main` — fast-forwards and resets included — refusing an
unblessed advance while allowing a `git pull` of history already on `origin/main`.
Proven live: `git merge --ff-only` of an unblessed branch is refused (main
unchanged); `BUREAU_ALLOW_MERGE=1` allows + journals an override. Unit tests:
6 `decideRefUpdate` cases in `tc_merge_guard.test.ts`. Walkthrough claim 4 and
the limitations note updated.

---

## Round 2 verdict: APPROVE

Senior (Claude CLI) re-reviewed after the fast-forward fix and returned
**VERDICT: APPROVE**. Verified by close static reading (the senior's sandbox
blocked running the suite, disclosed honestly): the ff-bypass is genuinely
closed (`decideRefUpdate` allows create/delete/no-op/override, else requires the
tip be on `origin/main` or pass `mergeAllowed`); `--no-verify` does not reopen it
(reference-transaction still fires); T45 assertions match real `pr_merge.ts`;
done-gate untouched. Non-blocking note (addressed): the guard is local-clone
scoped, now stated in the walkthrough's limitations.
