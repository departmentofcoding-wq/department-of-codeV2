# Walkthrough: fix ZCode senior harness abandoning reviews in the submit→generation gap

## Problem
The zai/ZCode senior repeatedly died in ~9s with "captured the senior app's empty
home screen (2 chrome markers, no VERDICT line)" on work.cycle reviews (dead jobs
1b588aee, 57114d4a for task 1429a7de), even after the 995f6d8 selector recalibration.

## Root cause
After sendPrompt, there is a brief gap before GLM shows its Stop button /
"Thinking…" indicator. During that gap the composer looks idle (Send control back,
nothing streaming), so waitForAgentIdle counted idleConfirmations and returned
'completed' at ~5-9s — capturing app chrome BEFORE the VERDICT line existed.
detectUncapturedReview then correctly refused the phantom and the job died, while
GLM kept working with its verdict orphaned. 995f6d8 fixed submit, not this wait
race — which is why plan reviews sometimes won the race and work.cycle reviews lost it.

## Fix
Add WaitOptions.requireActivityStart: an idle+stable reading may only be treated as
completion after the agent has been observed working (Stop/indicator) or its
transcript grew beyond the initial baseline at least once. A prompt that never
starts generating now stalls loudly (submit didn't land) instead of a false instant
completion. Enabled on ZCodeSession.waitForCompletion; DEFAULT OFF, so juniors and
every other caller are unchanged. The first-probe length baseline is explicitly not
counted as growth (realGrowth = grew && !firstProbe), so a fast agent still completes.

## Diff
```diff
diff --git a/engine/harness/agent-wait.ts b/engine/harness/agent-wait.ts
index 7bf8dd4..cb390b8 100644
--- a/engine/harness/agent-wait.ts
+++ b/engine/harness/agent-wait.ts
@@ -58,6 +58,16 @@ export interface WaitOptions {
   absoluteMaxMs?: number;
   /** Small initial delay so the working indicator can appear. Default 1200ms. */
   warmupMs?: number;
+  /** Require observing the agent actively working (a Stop/Cancel control or a
+   *  "Working/Thinking/…" indicator, or the transcript growing beyond its initial
+   *  baseline) at least once before an idle+stable reading may be treated as
+   *  completion. Closes the race where the brief gap between prompt-submit and
+   *  generation-start looks idle (Send control back, nothing streaming yet) and is
+   *  wrongly reported as an instant empty "completion" — which then captures the
+   *  app chrome instead of the reply. When the agent never starts within the stall
+   *  window, this yields a loud `stalled` (submit didn't land) instead. Default
+   *  false, so juniors and existing callers are unaffected. */
+  requireActivityStart?: boolean;
   /** Cancellation: checked every poll, and before the first. */
   signal?: AbortSignal;
   /** Progress callback (elapsed, current status, activity) for logging. */
@@ -80,12 +90,15 @@ export async function waitForAgentIdle(
   const idleConfirmations = opts.idleConfirmations ?? 2;
   const absoluteMaxMs = opts.absoluteMaxMs ?? 60 * 60 * 1000;
   const warmupMs = opts.warmupMs ?? 1200;
+  const requireActivityStart = opts.requireActivityStart ?? false;
   const sleep = opts.sleep ?? defaultSleep;
 
   const start = Date.now();
   await sleep(warmupMs);
 
   let lastLen = -1;
+  let firstProbe = true;
+  let sawActivity = false;
   let lastActivityAt = Date.now();
   let idleStable = 0;
 
@@ -95,6 +108,14 @@ export async function waitForAgentIdle(
     const a = await probe();
     const grew = a.len !== lastLen;
     if (grew) lastLen = a.len;
+    // The very first probe merely seeds the length baseline; only a working
+    // indicator or growth on a LATER probe proves the agent actually began
+    // generating. This is what tells "still spinning up after submit" apart from
+    // "genuinely done", so an idle reading in the submit→generation gap is not
+    // mistaken for completion.
+    const realGrowth = grew && !firstProbe;
+    if (a.working || realGrowth) sawActivity = true;
+    firstProbe = false;
 
     let status: string;
     if (a.working || grew) {
@@ -102,7 +123,7 @@ export async function waitForAgentIdle(
       lastActivityAt = Date.now();
       idleStable = 0;
       status = 'working';
-    } else if (a.canSend) {
+    } else if (a.canSend && (!requireActivityStart || sawActivity)) {
       // Idle and steady — confirm across a couple of polls, then it's done.
       idleStable++;
       status = `idle(${idleStable}/${idleConfirmations})`;
@@ -111,7 +132,11 @@ export async function waitForAgentIdle(
         return 'completed';
       }
     } else {
-      status = 'inactive';
+      // Genuinely inactive (error/modal/login wall) or, when requireActivityStart
+      // is set, still in the gap before generation has started. Both are bounded by
+      // the stall net below: a prompt that never starts generating stalls loudly
+      // instead of being read as an instant empty completion.
+      status = requireActivityStart && !sawActivity ? 'awaiting-start' : 'inactive';
     }
 
     opts.onTick?.({ elapsedMs: Date.now() - start, status, activity: a });
diff --git a/engine/harness/senior.ts b/engine/harness/senior.ts
index f5f3cee..ca0d7ae 100644
--- a/engine/harness/senior.ts
+++ b/engine/harness/senior.ts
@@ -681,7 +681,14 @@ export class ZCodeSession {
    * waiting while it's active and only stop on genuine completion or a stall.
    */
   async waitForCompletion(opts: WaitOptions = {}): Promise<WaitResult> {
-    return waitForAgentIdle(() => this.probeActivity(), opts);
+    // requireActivityStart: after sendPrompt there is a brief gap before GLM shows
+    // its Stop button / "Thinking…" indicator, during which the composer looks idle
+    // (Send control back, nothing streaming). Without this, the waiter counted that
+    // gap as an instant "completion" (~5-9s) and captured the app chrome before the
+    // VERDICT line existed — the review was abandoned while GLM kept working, so the
+    // verdict was orphaned and the job died on detectUncapturedReview. Requiring an
+    // observed start closes that race; a submit that never starts now stalls loudly.
+    return waitForAgentIdle(() => this.probeActivity(), { requireActivityStart: true, ...opts });
   }
 
   async readTranscript(lastLines = 60): Promise<string> {
```

## Verification (claims to check)
- 3 new unit tests in tc_agent_wait (waits through the gap then completes; the
  WITHOUT-flag control still completes instantly — documents the bug; WITH-flag a
  never-starting prompt stalls). 12/12 in that file.
- Full suite 522/522 across 105 files; tsc --noEmit clean.
- LIVE smoke through the fixed harness against ZCode 3.9.2: a real GLM review
  captured VERDICT: APPROVE in 55s (GLM worked 41s) — the same path that previously
  died at 9s.

## Scope / risk
Two files: agent-wait.ts (new opt-in option + start-observation logic) and senior.ts
(one call site opts in). No behavior change for callers that don't set the flag.
