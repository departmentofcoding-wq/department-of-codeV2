# Department of Code v2 — Phase 1 Plan: Intake

Handoff document for the two Junior Engineers. Senior Engineer: GLM-5.2 (Z.ai/ZCode).
Every milestone ends in a pull request the Senior reviews; the Human Operator
approves and merges. Phase 1 adds **no web UI, no verifier execution, no IDE
automation** — it builds the front desk: a task enters the department only
through a conversation with an officer, and no task reaches `queued` without a
verify command a human explicitly confirmed.

Phase 1's exit sentence: *a task filed from a terminal through an officer
conversation, with a confirmed verify command, lands in `queued` with its work
session minted and its whole attributed story in the journal — and the
conversation survives the runner being killed mid-turn.*

---

## 0. Ground rules (all of Phase 0's, plus)

- **Branches are now mandatory.** `wt/junior-a-front-desk` and
  `wt/junior-b-officer`, branched from `main` after the M1 contract merges.
  One PR per milestone. The Senior reviews; the Operator merges. Nothing
  lands in the working tree of `main` directly again.
- **No network in tests.** The officer runs against a scripted `mockClient`.
  Real Ollama is exercised only by an optional smoke script, never by vitest.
- **Schema changes go through `ADDED_COLUMNS`** in `engine/db/schema.ts`, not
  by editing the base DDL — existing databases must migrate in place, and this
  dogfoods the boot-migration path Phase 0 built.
- **One journal door, still.** Model calls write `llm` spans through
  `journal()`. The conversation itself lives in the intake message tables —
  messages are the conversation (needed for replay), spans are the accounting
  (tokens, cost, latency). Different facts, both attributed; neither
  duplicated.
- **The mutation rule, unchanged**: every PR names the guard it broke and the
  test that caught it.
- **API keys live in environment variables only.** `GOOGLE_API_KEY` (and any
  future key) is read from env at call time and is never written to the
  database, the journal, intake messages, or logs. A test enforces it (T18).

## 1. Model roster for this phase

| Role | Backend | Cost |
|---|---|---|
| Task Intake Officer | **local Ollama or Google Gemini (free tier)** — chosen by the `bureau_assignments` row, not by code | free |
| Everything else | unchanged from Phase 0 | — |

Two supported providers, one interface, selected by configuration:

- **Ollama** (default): `BUREAU_OLLAMA_URL`, default `http://127.0.0.1:11434/v1`.
  Install Ollama, pull one modest instruct model that fits RAM, enable it in
  the registry. No key, no quota, GPU-bound.
- **Google Gemini free tier** (optional): set `GOOGLE_API_KEY` (from AI
  Studio). Accessed through Gemini's OpenAI-compatible endpoint, so it rides
  the same client shape as Ollama. Free-tier quotas are real and small —
  requests per day and requests per minute, not just tokens — so the officer
  treats quota like money: budgeted, counted, and rotated away from when a
  429 arrives (v1's recorded experience: on the free tier, a 429 is an
  ordinary Tuesday, and quota decides the roster more than quality does).

Either provider can serve the officer; both can be enabled at once, with the
assignment deciding who starts and the cooldown/rotation rules deciding who
takes over when the first is rate-limited.

---

## 2. Milestone M1 — contract freeze (half a day, blocks both streams)

One PR into `main`, both juniors review, then freeze:

- **New tables (DDL + `ADDED_COLUMNS` entries + row interfaces):**
  - `bureau_intake_sessions`: `id`, `state ('open'|'filed'|'abandoned')`,
    draft fields (`title`, `intent`, `spec`, `acceptance`, `verify_cmd`),
    `verify_confirmed_at`, `verify_confirmed_by`, `idempotency_key`,
    `model_calls` (turn budget counter), `created_at`, `updated_at`,
    attribution of the creating actor.
  - `bureau_intake_messages`: `id`, `session_id` FK, `role
    ('human'|'officer'|'tool')`, `content` (JSON: text or tool call/result),
    attribution tuple + `tokens_in/out`, `latency_ms`, `created_at`.
- **`LlmClient` interface** (contract): `complete(request) → result`;
  request carries model id, messages (with tool definitions and prior
  tool_use/tool_result blocks), timeout signal; result carries text,
  tool calls, tokens in/out, latency, `cost_usd: null` for local and
  free-tier models. Three implementations: `mockClient` (tests),
  `ollamaClient`, `googleClient` — the two real ones both speak the
  OpenAI-compatible chat-completions shape (Gemini via its compat endpoint,
  authenticated with `GOOGLE_API_KEY` as a bearer token read from env).
  Provider config (base URL, key presence) resolves from env at call time
  and is never persisted.
- **Budgets are data**: `bureau_meta` keys for the rolling-24h token budget
  AND request-count budget (the free tier caps requests per day, which a
  token budget cannot see).
- **Officer tool schemas** (zod, shared): `propose_field {field, value}`,
  `propose_verify {command}`, `ask_human {question}`, `file_task {}`.
- **Pure functions in the contract, single source of truth:**
  - `isVacuousVerify(command)` — the refusal list (`exit 0`, `true`, `:`,
    `echo ok`/`echo`, `pass`, empty/whitespace). The officer's pre-flight and
    A's filing gate call the SAME function — v1's lesson: when two validators
    can disagree, they will, at the worst moment.
  - `taskGaps(draft)` — required-field completeness (title, intent, confirmed
    verify). The MODEL never decides completeness; this function does.
- **New job kind:** `intake.turn`.

## 3. Stream A — The Front Desk (Junior A: `engine/filing/`, `engine/intake/`)

| # | Deliverable | Acceptance |
|---|---|---|
| A1 | `fileTask(db, sessionId, attribution)` — **the one door into `bureau_tasks`**: validates via `taskGaps` + `isVacuousVerify`, requires `verify_confirmed_at` set by a human and matching the current `verify_cmd`, mints `work_uuid`/`work_title` once, honors `idempotency_key` (unique index; re-file returns the original task), journals a `task-filed` span, task born `queued` | T9, T10, T11 |
| A2 | Intake session store: create/open sessions, append attributed messages, update draft fields; a NEW `propose_verify` after confirmation **resets** `verify_confirmed_at` (a changed command is an unconfirmed command) | Draft persistence test; reset-on-reproposal test |
| A3 | `confirmVerify(db, sessionId, attribution)` — the human's act, refused for any non-`human-operator` role; records who/when | Refusal test (role gate, single-writer style) |
| A4 | Desk queries: open sessions, sessions awaiting verify confirmation, one session with full message history | Query tests |

## 4. Stream B — The Officer (Junior B: `engine/llm/`, `engine/officers/`, `scripts/`)

| # | Deliverable | Acceptance |
|---|---|---|
| B1 | `callModel` choke point: resolves the model via `bureau_assignments`, checks BOTH budgets FIRST (rolling-24h tokens and request count from journal rollups vs `bureau_meta` ceilings), runs the client with timeout, journals an `llm` span with the model's attribution (tokens/latency, cost `null` for local/free-tier), declines with a `guardrail` span + `notifyOperator` when over budget. **On a 429/quota refusal**: records a cooldown for that model in `bureau_meta` (provider's `retry-after` when present, else a default), rotates to the next enabled model for the role, and refuses rather than rotating if no model is left — rotation must spend the queue, never the budget | T15, T17; span attribution test |
| B2 | Clients: `ollamaClient` + `googleClient` (both OpenAI-compatible; Gemini's base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, key from env, never logged) + `mockClient` (scripted turns, scriptable 429s). Registry: known Gemini free-tier models seeded `provider: 'google'`, unpriced, **disabled until `GOOGLE_API_KEY` is present**; health/list helpers for both providers | Unit tests use mock only; optional `npm run smoke:llm` against whichever provider is configured |
| B3 | `taskIntakeOfficer` turn loop: builds the message array **replaying every prior `tool_use` and `tool_result` block each turn** (v1's founding bug was omitting this — the officer asked the same question forever); tools bound to the session store; `propose_verify` pre-flights through the shared `isVacuousVerify`; deterministic gap check after every turn (`taskGaps` decides, never the model); hard cap 10 model calls per `intake.turn` job — at the cap without a question, the gap report supplies the next question | T12 (mutation: remove the replay, watch it fail) |
| B4 | `intake.turn` job kind: loads the session, runs one turn, persists messages + draft; idempotent on re-run after a crash (state lives in the store, not memory); abort-aware. CLI: `npm run intake -- "fix the login bug"`, `--answer "..."`, `--confirm-verify`, `--show` — the only door a human speaks through | T14 (real kill mid-conversation, resume) |
| B5 | Attribution in practice: officer turns in the ledger attributed to the Ollama model; end-to-end mock happy path | T13, T16 |

## 5. Milestone X2 — integration (both)

Merge order: `M1 → A1/A2/A3 → B1–B4 → X2`.

**Exit tests** (in `test/integration`, continuing the numbering):

- **T9** — filing door refuses every vacuous verify command on the shared list.
- **T10** — filing twice with the same idempotency key yields one task; the
  second call returns the first.
- **T11** — no filing without human confirmation; a re-proposed command
  requires fresh confirmation.
- **T12** — tool-replay: with the mock officer scripted to propose verify and
  then ask again, removing the tool-result replay from the message array
  fails the test (the mutation is run and recorded).
- **T13** — full happy path on mocks: file → question → answer →
  propose_verify → human confirm → `file_task` → task `queued`, work session
  minted, journal tells the story in order with every span attributed.
- **T14** — durability: `kill` the runner process mid-officer-turn (real
  child, hard kill), restart, the conversation resumes from the store with no
  duplicated messages and the turn budget intact.
- **T15** — budget ceiling: with the ceiling set low and a mock that would
  happily keep talking, the officer declines, journals a `guardrail` span,
  notifies the operator, and no call beyond the budget is ever made.
- **T16** — attribution exactness: ledger rollups for the officer model match
  the mock's reported tokens exactly.
- **T17** — quota rotation: the mock returns 429 for the role's first model;
  the call rotates to the second enabled model and succeeds, the cooldown is
  recorded in `bureau_meta`, both attempts are journaled and attributed to
  their own models, and with every model cooling the officer declines instead
  of hammering.
- **T18** — key hygiene: after a full mocked conversation using a fake
  `GOOGLE_API_KEY`, the key's value appears nowhere — not in any journal span
  (including `detail`), not in any intake message, not in `last_error`.

## 6. Explicitly out of scope for Phase 1

Web UI, verify *execution* (confirmation only — the Verifier runs in Phase 2),
task worktrees, the Antigravity harness, the Senior's review harness,
notifications beyond the existing stub, the Secretary.
