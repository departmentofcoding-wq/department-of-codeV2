# Senior Review Integration

How the department drives its **two seniors** from code. Seniors do **not** write
code — they **review** the artifacts the juniors produce (the implementation
**plan** before coding, the **walkthrough** after) and return a verdict the
department flow acts on. Mirrors the junior harness and its override seam.

## The two seniors

| Id | Reviewer | Mechanism | Notes |
|---|---|---|---|
| **claude** | Claude Code CLI | **subprocess** — `claude -p --append-system-prompt <rubric>`, prompt on stdin, verdict on stdout | Installed at `~/.local/bin/claude` (v2.1.220), authed against `api.anthropic.com`. Override path with `CLAUDE_CLI_PATH`, model with `CLAUDE_SENIOR_MODEL`. |
| **zai** | ZCode (Z.ai GLM desktop agent) | **CDP** — Electron/Chromium GUI driven like the juniors on port `9335` | Installed at `…\Programs\ZCode\ZCode.exe`. Override with `ZCODE_PATH`. |

## Components

| File | Role |
|---|---|
| `engine/harness/senior.ts` | Core: `SENIORS` registry, `resolveSenior`, pure `buildReviewPrompt` / `parseVerdict`, `ClaudeCliSenior` (subprocess), `ZCodeSession` + `ZCodeSenior` (CDP), `makeSeniorDriver`. |
| `engine/harness/senior-seam.ts` | Override-able `SeniorDriver` seam (`getSeniorDriver`/`setSeniorDriverOverride`) — real drivers live; tests inject a fake. |
| `engine/harness/junior-artifacts.ts` | `readLatestArtifacts(taskId)` — reads the newest captured `plan.md`/`walkthrough.md` for a senior to review. |
| `scripts/run_senior.ts` | CLI (`--senior`, `--kind`, `--file`/`--task`, `--title`). |

## One reviewer per artifact (assignment policy)

Having **both** seniors review the same artifact is wasteful, so `assignSenior({kind})`
picks exactly **one**. Default splits the load: **plans → claude**, **walkthroughs → zai**.
Override per-kind with env `SENIOR_PLAN` / `SENIOR_WALKTHROUGH`, or globally with
`SENIOR_DEFAULT`. `scripts/run_senior.ts` uses this automatically when `--senior` is omitted.

## Model selection (both seniors)

- **Claude:** pass `model` on the review (or `--model` on the CLI, or `CLAUDE_SENIOR_MODEL`)
  → forwarded to `claude -p --model`.
- **ZCode:** `ZCodeSession.selectModel(name)` drives the in-GUI **"Choose model"**
  picker (currently **GLM-5.2**); pass `model` on the review to select before sending.
  Verified live: selecting GLM-5.2 then reviewing returned a clean `APPROVE`.

## Adaptive completion wait (no hard time cap)

Autonomous agents finish at wildly different times — a GLM senior may re-run the
whole suite, browse the app, and `git show` the commit before answering. So there
is **no fixed ceiling** on how long a junior or senior may take. `engine/harness/agent-wait.ts`
(`waitForAgentIdle`) polls the agent and:

- **still working** (a Stop/Cancel control, a "Working/Generating/Thinking" indicator,
  or the transcript still growing) → keep waiting, indefinitely, resetting the stall timer;
- **idle & stable** (Send control back, text steady across a couple of polls) → completed;
- **inactive with no progress for `stallMs`** (default 120s — an error, login wall, or
  modal, not a legitimate long run) → stalled; give up.

The only real bound is the **inactivity window**, not elapsed time. Both
`AntigravitySession.waitForCompletion` (junior) and `ZCodeSession.waitForCompletion`
(senior) use it; the seams pass `stallMs`, never a hard cap. Unit-tested in
`test/unit/tc_agent_wait.test.ts` (incl. "an actively-working agent is never cut off").

Known follow-up: when the ZCode/GLM senior spawns **side panes** (Terminal/Browser/Review)
during a deep audit, its final verdict can land outside the main transcript — a ZCode-UX
capture calibration separate from the wait logic.

## Quota / usage

- **ZCode:** `ZCodeSession.readUsage()` opens the **"Usage remaining"** control and
  returns the readout (best-effort — it renders as a popover/tooltip).
- **Claude:** no headless CLI quota readout — run `/usage` inside the Claude Code app,
  or see console.anthropic.com. `usageHint(id)` returns the right guidance per senior.

## Calibrated ZCode selectors (live, GLM desktop)

Workbench is a `file://…/app.asar/out/renderer` page. Chat input is a
`div[role="textbox"][contenteditable]` (placeholder "Ask ZCode anything…"); **Send**
is `aria-label="Send"`; model picker `aria-label="Choose model"`; quota
`aria-label="Usage remaining"`; workspace `aria-label="Choose workspace"`; mode
`aria-label="Switch mode"` (Ask before changes / Edit automatically / **Plan mode** /
Full access — a reviewer is safest in a non-editing mode). Enter alone may not submit,
so `sendPrompt` clicks **Send** as a fallback (same scar as the juniors).

## The review contract

`SeniorDriver.review(input)` takes `{ kind: 'plan'|'walkthrough', taskTitle,
taskSpec?, plan?, walkthrough? }` and returns `{ senior, verdict, feedback, raw,
model? }` where `verdict` is `'approve' | 'revise'`. Verdict parsing is
**genuinely fail-closed**: the senior is told to start its reply with
`VERDICT: APPROVE` / `VERDICT: REVISE`; a reply with NO explicit marker —
including approval-sounding prose like "I don't think this should be approved
as-is" — parses to `revise`. There is deliberately no approve-by-heuristic
fallback: an unreadable, truncated, or nuance-worded review never
auto-approves. A stalled/aborted/timeout senior wait is a hard error
(`ensureCompleted`), never a parsed verdict.

## Usage

```bash
# Claude senior reviews a plan file:
node --experimental-strip-types scripts/run_senior.ts --senior claude --kind plan \
  --file path/to/plan.md --title "build a one-button clicker"

# Review the LATEST captured artifacts for a task (docs/junior-artifacts/<taskId>/):
node --experimental-strip-types scripts/run_senior.ts --senior claude --kind walkthrough \
  --task <taskId> --title "build a clicker"

# ZCode (GLM) senior over CDP (see precondition below):
node --experimental-strip-types scripts/run_senior.ts --senior zai --kind plan \
  --task <taskId> --title "build a clicker"
```

## Preconditions

- **Claude senior:** the `claude` CLI on PATH (or `CLAUDE_CLI_PATH`), already
  logged in. Verified live: a good plan → `APPROVE`, an over-engineered plan →
  `REVISE`, with reasoning — no code written.
- **ZCode senior (CDP):** ZCode must expose a debug port on `9335`. Because
  Electron requires the flag at launch **and** ZCode keeps its login only on the
  default profile (a fresh `--user-data-dir` starts logged-out and self-closes),
  you must **fully quit ZCode**, then relaunch it with the flag:
  ```powershell
  & "$env:LOCALAPPDATA\Programs\ZCode\ZCode.exe" --remote-debugging-port=9335
  ```
  The `ZCodeSenior` driver refuses with this instruction if the port is not live.
  The chat-input selector (`ZCODE_INPUT_MATCHERS`) is best-effort until calibrated
  on the first live attach.

## Plan-review cycle — the corrected order (junior authors, senior reviews)

`engine/flow/plan_review_cycle.ts` implements the department's planning stage in the
right order:

```
TASK → junior AUTHORS the plan → rubric GATES it → senior REVIEWS it (with the task verbatim) → approve | revise
```

`runPlanReviewCycle(db, { taskId, junior, seniorId, ... })` — the integrated flow
(a `plan.cycle` job kind; the CLI enqueues and drains it as a real job):
1. **State + ceiling entry-guards:** only `queued`/`claimed` tasks may plan, and at
   `plan_rounds >= ceiling` (meta `review:plan_rounds_ceiling`, default 3) the
   cycle REFUSES — guardrail span, task blocked, operator notified — before any
   agent is touched.
2. Asks the junior (Antigravity) for a **plan only** — no code — via `buildJuniorPlanPrompt`
   (the task verbatim + the department plan standard: branch `wt/…`, enumerable scope,
   tests + mutation evidence, walkthrough plan; a prior round's senior feedback is
   relayed verbatim). The stall window is `juniorStallMs` (default 120s — the agent
   may work arbitrarily long while it keeps making progress). Writes a `bureau_plans`
   row (`actor_role='junior-engineer'`, `provider='antigravity'`, honest model label)
   + an `observation` span.
3. **Deterministic rubric gate** (zero senior tokens): a plan missing the standard —
   including junk transcript fallbacks — is amended by the rubric and the cycle loops.
4. Hands the plan **plus the task verbatim** to the assigned senior. Writes a
   `bureau_plan_reviews` row (`approve`→`approved`, `revise`→`amend`) + a `review`
   span, and increments `plan_rounds`.
5. **Continuation:** approve → a `bureau_dispatches` row + a `junior.dispatch` job
   whose prompt embeds the approved plan (same junior who planned it); revise →
   the next `plan.cycle` round is enqueued WITH the senior feedback — until the
   ceiling blocks the task.

Run it: `node --experimental-strip-types scripts/run_plan_cycle.ts --task <id> --junior B --senior claude`.

**Verified live (pre-integration shape):** junior B authored a real temperature-converter
plan; the Claude senior reviewed it against the spec + acceptance ("single file", "live"
update, the C→F formula) and returned APPROVE — real DB rows and journal spans written
to an isolated DB. The integrated `plan.cycle` job path is unit/integration-tested with
fake drivers (`tc_plan_cycle.test.ts`); its first LIVE run is Phase 7 C1 scope.

## Flow integration

The department's built-in review job (`engine/review/plan_review_job.ts`) uses the
internal `callModel` seam after a deterministic rubric gate. The senior harness is
the **external** reviewer path: call `getSeniorDriver('claude'|'zai').review(...)`
with `readLatestArtifacts(taskId)` to have a real Claude/GLM senior judge the
captured plan/walkthrough. Both juniors and both seniors are now driven by the
department: junior produces plan → senior reviews → junior produces walkthrough →
senior reviews. The `plan.cycle` flow is the jobs-machinery integration of exactly
that path — same guards as the legacy job (ceiling, rubric, continuation), live
agents behind the seams.

## Tests

- `test/unit/tc_senior.test.ts` — registry, `buildReviewPrompt` (forbids coding,
  demands VERDICT line), `parseVerdict` (fail-closed), seam override, and
  `readLatestArtifacts`.
