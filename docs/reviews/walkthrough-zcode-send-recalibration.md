# Walkthrough — ZCode 3.8.1 senior harness recalibration (send + completion)

Branch: `wt/zcode-send-recalibration` (cut from `main`)
File: `engine/harness/senior.ts` — two calibrated regions in `ZCodeSession`.

## Problem

The ZCode (zai / GLM) senior stopped driving after ZCode upgraded to **3.8.1**.
Running `run_senior.ts --senior zai` failed at the submit step:

> ZCode: the review prompt was typed but never submitted (no working Send/Submit control).

The department's guards behaved correctly — they **failed loudly** rather than
recording a phantom verdict — but the GLM senior (a genuinely independent,
model-diverse reviewer, and the default for walkthroughs) was unusable, forcing
every review onto the `claude` CLI senior.

## Root cause (diagnosed live over CDP against ZCode 3.8.1)

Two independent calibration drifts, both isolated with read-only DOM probes:

1. **Submit.** The composer is a multiline rich-text editor. Enter inserts a
   newline (never submits), and the editor does **not** clear the
   contenteditable's DOM text when a message is sent. The old submit logic
   "pressed Enter, then verified the box emptied" — so it neither submitted nor
   recognized a submit. Probes proved: `Input.insertText` *does* register in the
   editor model (the Send button flips `disabled:true`→`false`), and clicking the
   real Send control sends the message (GLM received a calibration ping and
   replied). The real control is `button[data-testid="v4-composer-send"]`
   (aria-label "Send", type=submit), enabled only while the model is non-empty.

2. **Completion detection.** `probeActivity`'s `canSend` was gated by an
   `onHomeScreen` heuristic keyed on `SENIOR_HOME_SCREEN_MARKERS`
   ("Add context", "Full access", "Plan mode", …). In 3.8.1 those are **normal
   composer controls**, present in every active conversation — so `onHomeScreen`
   was always true, `canSend` always false, and the waiter could never confirm
   completion. Every finished review therefore ran out the inactivity window and
   was reported as a **stall**. Sampling the compose controls during vs after
   generation showed the reliable signals: while GLM generates, the Send button
   is replaced by `[data-testid="v4-stop"]`; when done, `[data-testid=
   "v4-composer-send"]` returns.

## The fix

- **`sendPrompt` submit** — click `[data-testid="v4-composer-send"]` (fallback:
  aria-label "Send" / type=submit). Refuse loudly if the control is missing, or
  if it is disabled at click time (text never registered). Confirm the send was
  accepted by the Send button re-disabling / a Stop control appearing — never by
  reading the (unreliable) DOM text. Enter is no longer used to submit.
- **`probeActivity`** — `working` = `[data-testid="v4-stop"]` present (or a
  `/^(stop|cancel)$/i` label, or a standalone progress label as before);
  `canSend` (idle/done) = `[data-testid="v4-composer-send"]` present AND not
  working. The stale `onHomeScreen`/home-marker gate is removed from the activity
  probe. `SENIOR_HOME_SCREEN_MARKERS` remains, still used by
  `detectUncapturedReview` (unchanged), so the phantom-home-screen guard stays.

No behavioural change to any other senior, to the pure functions
(`buildReviewPrompt`, `parseVerdict`, `detectUncapturedReview`), or to the
`claude` CLI senior.

## Evidence

- **Live end-to-end (the real proof):** after the fix,
  `run_senior.ts --senior zai --kind walkthrough` on the (already-merged)
  console-projects-mobile-ntfy walkthrough **completed** — GLM worked 8m33s, then
  returned `VERDICT: APPROVE` after independently re-running the suite twice
  (435/435), the build, and re-checking the diff/commit-range/journal hygiene.
  Before the fix the same command failed at submit (round 1) and at a false stall
  (round 2, after only the submit half was fixed). Full completion is the
  calibration proof.
- Pure-function tests (`tc_senior`) unchanged and green; full suite 435/435,
  `npm run build` clean on this branch.
- `sendPrompt`/`probeActivity` drive a live IDE over CDP and are not unit-tested
  (no fake DOM) — same "verified live" standard as the original Antigravity/ZCode
  integration commits.

## Scars recorded
GUI selector calibration is version-fragile. Prefer stable `data-testid`s
(`v4-composer-send`, `v4-stop`) over visible-label heuristics, and never treat a
contenteditable's DOM text as a submit signal — the editor model and the DOM can
disagree.
