# Plan — N0: junior "completion" fires before the agent is done

**Status:** implemented on `wt/junior-a-n0-junior-completion` (2026-09-01): live
observation DONE (§Step 1 results below — fix C dead, fix A chosen and proven), gate +
sentinel + prompt instruction landed, 3 agent-wait tests + 3 builder assertions,
mutations M-N0a/b recorded; suite 663/663 ×2, tsc clean. Awaiting senior verdict →
operator merge. · **Priority:** P0 (the LAST P0 gating any ≥3-task concurrent run;
N3 and b55e2fda's window-scoping are already merged) · **Source:** `docs/plan-pre-phase8-remaining.md` §N0,
ledger "NEXT INSTANCE — START HERE" item (1).

Prereq satisfied 2026-09-01: both juniors calibrated live (A@9333, B@9334, exact-marker
smoke green). Cold-start scar noted: first send after a cold launch can fail "Chat input
not found" (`ensureChatInputReady` 20s < cold boot + panel mount) — a warm retry works; the
N0 harness run should launch juniors warm or retry once.

---

## Root cause — confirmed in code

The department decides a `junior.dispatch` is **done** by watching the IDE **chat pane**, not
the agent's actual work. `waitForAgentIdle` ([agent-wait.ts:134-141](../engine/harness/agent-wait.ts:134))
returns `completed` when the **Send** control is back and the transcript held steady for
`idleConfirmations` (2) polls. The probe that feeds it
([antigravity.ts:996-998](../engine/harness/antigravity.ts:996)) computes:

```
working = (Stop|Cancel button present) OR (a standalone "Working/Generating/Thinking" label)
canSend = (Send button present)
len     = visible transcript length
```

`requireActivityStart` ([agent-wait.ts:116-124](../engine/harness/agent-wait.ts:116)) only
guards the **front** gap (submit → generation start). Once activity was seen **once**, a
**mid-run** lull — the agent launched a terminal subprocess (e.g. `vitest`) and is *waiting on
it* — reads as `working=false, canSend=true, len steady` → **`completed`**, even though the
agent will come back and keep editing.

**Live-verified fingerprint:** `b55e2fda`'s dispatch was declared complete at **~38s**; its
transcript ends with *"I have launched the initial vitest run to verify the baseline before
making any edits."* The agent kept implementing through the senior-review and verify phases —
the direct cause of the unreviewed post-approval edits (N1) and a contributor to the N3
contamination.

**The gap in one sentence:** "chat pane is quiet" ≠ "agent is finished" — a quiet chat during
a 40-second terminal run is indistinguishable, to the current probe, from a completed task.

---

## Step 1 — the live observation (operator-paired, do FIRST)

The fix depends on **what the Antigravity DOM actually shows while the agent waits on its own
subprocess** — that can't be known from the code. So before writing any fix:

1. Bring a junior up warm (A@9333 or B@9334).
2. Send a prompt that forces a long terminal run *then* more edits, e.g. *"First run
   `npx vitest run` and wait for it to finish; then add a one-line comment to `README`."*
3. While it runs, sample `probeActivity()` every ~2s (a small harness script, or reuse
   `waitForCompletion` with an `onTick` logger) and record, at the subprocess moment:
   - Is the **Stop/Cancel** button still present? (If yes — the current probe already stays
     `working` and there may be no bug for *this* IDE state; the b55e2fda case then came from a
     different idle shape worth capturing.)
   - Is there any **terminal-busy / running-task** indicator anywhere outside the chat
     composer (a spinner, a "Running" tab badge, a disabled input)?
   - Does **Send** actually reappear during the gap? Capture the DOM snippet if so.

The answer picks the fix below. **Record the observed DOM in this doc before implementing.**

---

## Step 1 results — LIVE OBSERVATION DONE (2026-09-01, junior A @9333, warm)

Script: `scripts/n0_observe.ts` (throwaway harness script, kept for the record).
Prompt: run `node -e "setTimeout(...,90000)"` in the terminal, wait, then reply
`N0-OBSERVATION-COMPLETE`. Probe sampled every 2s, DOM recon every 10s. Raw log
preserved at `docs/junior-artifacts/n0-observation-run4.log`.

Timeline (condensed):

| t | probe | DOM |
|---|---|---|
| 2–6s | working=true | terminal `Cancel (Ctrl+D)` present (active turn) |
| 8s→93s | **working=false, canSend=true, len steady** | recon: only `Send message` — **no Stop, no Cancel, no spinner, no busy chrome**; `termCancel` GONE |
| **12s** | **current rule (idle+stable×2) would COMPLETE** | ~85s of pending subprocess left — the b55e2fda "~38s" signature reproduced |
| 95s | len grows (agent **resumes on its own**) | `Cancel (Ctrl+D)` back (active turn) |
| 97s | marker `N0-OBSERVATION-COMPLETE` in REPLY REGION | genuine completion |

**Findings that pick the fix:**
- **C is dead.** During the quiet gap the IDE renders *finished*: no Stop/Cancel/
  progress label anywhere the probe queries; the terminal Cancel control exists
  only during active agent turns. There is no clean terminal-busy DOM signal to
  fold into `working`. (The agent *ends its turn* with the subprocess running —
  "I will monitor it" — so the turn boundary itself is the lie.)
- **A is proven.** The agent obeys a final-marker instruction, and the marker
  lands exactly at true completion. It MUST be detected only in the reply
  region (after the sent prompt): the echoed prompt contains the string too
  (first-hand scar from observation run 1 — the detector matched at t=2s).
- **B remains a complement** but is not wired here (needs worktree plumbing;
  keep as follow-up hardening).
- Consequence for the stall net: with the gate holding the wait OPEN through a
  gap, the existing `stallMs` (120s default) would fire mid-subprocess on longer
  test runs → the gate needs its own, longer evidence timeout so a genuinely
  finished-but-markerless agent still fails LOUD (stalled), never silently.

**Chosen fix: A** — completion sentinel + evidence-gated completion, detailed in
Step 2 below (as implemented).

---

## Step 2 — the fix (pick from evidence; prefer belt-and-suspenders)

Ordered by robustness. Likely final shape = **A + B**, with **C** if the DOM offers a clean
signal.

Ordered by robustness. Likely final shape = **A + B**, with **C** if the DOM offers a clean
signal.

- **A. Explicit completion sentinel (IDE-agnostic, strongest).** The junior prompt instructs
  the agent to print a unique end marker (e.g. `===JUNIOR-DISPATCH-COMPLETE===`) as its final
  line **only when the requested work is fully done**. Completion then requires *both* idle+
  stable *and* the marker present in the transcript. A subprocess gap has no marker → not
  complete. Downside: relies on agent obedience (LLM), so keep idle+stable as a necessary
  co-condition and the stall net as the backstop.
- **B. Evidence-of-work-landed guard.** Before accepting completion, require objective
  evidence the task actually touched the tree: `git -C <worktree> status --porcelain` is
  non-empty (or the expected walkthrough/plan artifact exists). Cheap, deterministic, and
  catches the "declared done at 38s having only launched a test" case directly (nothing had
  landed yet). Complements A.
- **C. Terminal/tool-activity in the probe.** If Step 1 shows a reliable "terminal running"
  DOM signal, extend `probeActivity` to fold it into `working` so a subprocess gap counts as
  working (no completion, stall timer reset). Only as robust as the selector — hence a
  supplement to A/B, not a replacement.
- **Rejected: just enlarge `idleConfirmations`/`stallMs`.** A real subprocess can run minutes —
  longer than any safe idle window — so a bigger window either still completes early or stalls
  legitimate fast finishes. Not a fix, only a band-aid.

Keep `requireActivityStart` as-is (it already closes the front gap). N0 adds a **completion**
gate, symmetric to that **start** gate.

---

## Step 3 — tests + mutation

- **Unit (`agent-wait`).** Drive `waitForAgentIdle` with a scripted probe sequence:
  `working → (idle gap: !working, canSend, len steady for >2 polls) → working → idle+stable +
  marker`. Assert it does **NOT** return `completed` during the gap and only completes after
  the marker/evidence. This is the exact b55e2fda shape, locked in.
- **Unit (sentinel/evidence).** The completion predicate returns false when the marker is
  absent / the worktree is clean, true when present/dirty.
- **Mutation M-N0.** Reverting the new gate (accept idle+stable alone) must turn a test red.
  Record in `docs/mutation-evidence-phase8.md`.
- Full suite + `tsc --noEmit` green (run in calm conditions — the `t4_crash_resume` lease-reap
  flake aggravates under GUI/CPU load; it is not an N0 signal).

---

## Step 4 — review + delivery (zai)

Engine-dev change (`engine/harness/*`). Branch → **zai senior review** → `--no-ff` merge to
local main → re-verify (suite ×2 + tsc) → push is the operator's call.

**N10 caveat — mandatory before driving zai:** `run_senior --senior zai` has no guard against
attaching to a **non-senior** ZCode window on 9335. If 9335 is hosting a working session, the
review self-attaches and scrapes that session's own transcript — a phantom verdict (the void
2026-09-01 N3 attempt). **Drive zai only from a dedicated ZCode senior instance on 9335 that
is not doing the work**, and sanity-check the captured review is the diff, not a transcript,
before trusting the verdict. (Fixing N10 itself is a separate P1 item.)

---

## Out of scope / sequencing

- **N1 option (a)** (real junior verify-fix dispatch) unblocks *after* N0 — with completion
  gated correctly, the worktree is clean at verify time, so the only way the tip moves is a
  deliberate fix dispatch, which the M-N1 guard already forces back through review.
- After N0 merges: the ≥3-task concurrent run that officially opens Phase 8
  (`docs/phase-8-plan.md`).
