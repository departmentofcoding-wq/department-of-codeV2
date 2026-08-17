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

## 1. Model roster for this phase

| Role | Backend | Cost |
|---|---|---|
| Task Intake Officer | local Ollama (OpenAI-compatible endpoint), structured tools | free |
| Everything else | unchanged from Phase 0 | — |

Operator setup (once, before B3): install Ollama, pull one modest instruct
model that fits RAM, enable it in the registry. `BUREAU_OLLAMA_URL` defaults
to `http://127.0.0.1:11434/v1`.

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
  tool calls, tokens in/out, latency, `cost_usd: null` for local models.
  Implementations: `mockClient` (tests), `ollamaClient` (B2).
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
| B1 | `callModel` choke point: resolves the model via `bureau_assignments`, checks the token budget FIRST (rolling 24h from journal rollups vs `bureau_meta` ceiling), runs the client with timeout, journals an `llm` span with the model's attribution (tokens/latency, cost `null` for local), declines with a `guardrail` span + `notifyOperator` when over budget | T15; span attribution test |
| B2 | `ollamaClient` (OpenAI-compatible chat completions with tool support) + `mockClient` (scripted turns) + Ollama health/list helper (`provider: 'ollama'`, unpriced, disabled until the operator enables) | Unit tests use mock only; optional `npm run smoke:ollama` |
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

## 6. Explicitly out of scope for Phase 1

Web UI, verify *execution* (confirmation only — the Verifier runs in Phase 2),
task worktrees, the Antigravity harness, the Senior's review harness,
notifications beyond the existing stub, the Secretary.
