=== VERDICT (claude): APPROVE ===
## VERDICT: APPROVE

**Task match:** The task asked to fix the submit→generation-start race in `waitForAgentIdle` without changing junior behavior. That's exactly what this delivers — a new opt-in `requireActivityStart` flag, defaulted `false`, enabled only on `ZCodeSession.waitForCompletion` (the senior path). Confirmed by grep that the other two callers (`antigravity.ts`'s own `waitForCompletion` and `antigravity-seam.ts`) don't pass the flag and are untouched.

**What I verified directly** (branch `wt/fix-zcode-senior-capture`, commit `e540dac`, one commit ahead of main's `995f6d8`, not yet merged):
- Diff in the walkthrough matches the actual commit byte-for-byte in both `agent-wait.ts` and `senior.ts`.
- Hand-traced the algorithm against the new `gapThenWorkThenIdle` test fixture step-by-step: the two "still in the gap" frames correctly produce `awaiting-start` instead of premature completion, and completion only fires after real activity is observed — confirms the race is genuinely closed, not just documented.
- Traced the "without flag" control test and the "stall" test — both produce the claimed results given the current `stallMs`/`idleConfirmations` logic. The stall-net math is sound: `lastActivityAt` is never refreshed while `awaiting-start`, so a prompt that never starts still bounds out via `stallMs`.
- Test count: `tc_agent_wait.test.ts` has exactly 12 `it(...)` blocks on the branch (9 existing + 3 new), matching the "12/12" claim.
- No other code branches on the literal `'inactive'` status string, so renaming part of it to `'awaiting-start'` is safe — it's log-only.
- Imports/types are consistent; nothing looks like it'd fail `tsc --noEmit`.

**What I could not verify:** I couldn't execute the suite in this sandbox — `git worktree add` and branch-switching both hit unresolvable approval prompts (non-interactive session), and switching the shared main working tree directly is unsafe here since a live autonomous session may be committing to `main` concurrently. So the "522/522 full suite," "tsc clean," and the live 55s GLM smoke-test claims are taken on the junior's word, not independently re-run. Nothing in the static trace contradicts them, and the change is small/isolated enough that I have no specific reason to doubt them — flagging only for completeness.

**Scope/risk:** Matches the stated two-file (+ one test file) footprint, no junior-path regression risk, well-reasoned root cause tied to the actual dead-job evidence (1b588aee, 57114d4a). Good to merge.

[exited with code 0]
