# Department of Code v2 — Phase 3 Plan: The Junior Harness (CDP, Selectors, Nonces, Window Lease)

Handoff document for the two Junior Engineers. Senior Engineer: GLM-5.2
(Z.ai/ZCode). Every milestone ends in a pull request the Senior reviews; the
Human Operator approves and merges — and per AGENTS.md, nothing reaches main
until a Senior verdict is posted for that exact hash. Phase 3 adds the
machinery that lets a junior engineer (an LLM) actually work in a browser
IDE: a CDP client, a calibrated selector registry, nonce-correlated
attribution, and an exclusive window lease. The exit sentence:

A dispatched junior holds an exclusive lease on one browser window; every
action it takes flows through calibrated selectors and lands in the journal
under a nonce that ties the dispatch, the action, and the observed DOM
effect into one attributable chain; an uncalibrated selector stops the
action before the browser sees it; a crashed dispatch loses its lease, not
its record; and the window comes back clean.

## 0. Ground rules (all of Phase 1–2's, plus)

Read AGENTS.md and `docs/DEPARTMENT_STATUS.md` first. The merge discipline
is now standing law: posted Senior verdict before anything reaches main.

Branches: `wt/junior-a-cdp` and `wt/junior-b-selectors`, cut from main
after the C0 freeze merges. One PR per milestone.

**The browser is local or it is nothing.** Tests launch their own
Chromium/Edge instance (`--headless=new`, temp `--user-data-dir`, a random
free `--remote-debugging-port`) and drive `file://` fixture pages. No
internet, ever. If no browser binary is found the test fails loudly with
instructions, never silently skips.

**The CDP client is the only door to the browser.** No test or engine code
opens pages, clicks, or reads the DOM any other way. The client is
hand-rolled over Node's global `WebSocket` against the DevTools HTTP
endpoints — no new npm dependencies without Senior sign-off.

**The calibration gate is code, not convention.** Acting through a selector
whose `bureau_selectors.status` is not `calibrated` throws before any
browser message is sent, and the refusal is journaled as a `guardrail` span.
Where a rule can be a CHECK or partial UNIQUE index instead of an `if`, it
is.

**The seam is the contract.** `IdeDriver` (launch/attach, navigate, read,
act, snapshot, close) lives in the frozen contract with a
`setIdeDriverOverride` hook, mirroring `workspace-seam.ts`. Stream B tests
against a `FakeIdeDriver` serving static HTML fixture pages; Stream A owns
the real CDP implementation; they meet at CX.

**Nonces are unguessable** (`crypto.randomBytes(16)`), minted once per
junior action, and correlation is by exact equality only — no prefix
matching, no fuzzy joins. Every action produces exactly one journal span and
at most one `bureau_observations` row under the same nonce.

Budgets are columns and `bureau_meta` keys: `harness:lease_ms` (default
120000), `harness:lease:heartbeats` ceiling, `dispatch:attempts` on
`bureau_dispatches` (added via `ADDED_COLUMNS` in C0). Schema changes follow
the Phase 2 rules: new tables in base DDL as `CREATE TABLE IF NOT EXISTS`,
new columns through `ADDED_COLUMNS`, every change shipped with a migration
test that boots an old-shaped database.

The mutation rule, unchanged: every PR names the guard it broke and the
test that caught it; evidence in `docs/mutation-evidence-phase3.md`.

## 1. Model roster for this phase

| Role | Backend | Cost |
|---|---|---|
| CDP client, lease, registry, gate, nonces — all harness mechanics | Pure TypeScript | free |
| Junior decisions inside a dispatch (CX only) | Existing Phase 1 choke point (`callModel`, Ollama/Gemini), overridden by the existing mock client in tests | per token |

Tests never spend model calls. CX's end-to-end test and `demo_phase3` use
the mock client with a scripted decision sequence; one optional
`scripts/smoke_junior.ts` exercises a real model the way `smoke_llm.ts`
does, outside the suite.

## 2. Milestone C0 — contract freeze (half a day, blocks both streams)

One PR into main, both juniors review, then freeze:

- **Seam** (`engine/contract/types.ts` + `engine/contract/ide-driver-seam.ts`):
  `IdeDriver` with `launch(opts)`, `navigate(url)`, `read(selectorKey)` →
  `{ matchCount, text?, attrs?, nonceEcho }`, `act(selectorKey, action,
  value?)`, `snapshot()` (compact DOM outline for a model), `close()`;
  plus `setIdeDriverOverride` / `getIdeDriver` following the
  `workspace-seam.ts` pattern (default-if-unset wiring in the Runner
  constructor, so test overrides survive).
- **New tables** (base DDL):
  - `bureau_selectors`: `id`, `key` (UNIQUE), `css`, `status`
    (`draft|calibrating|calibrated|failed` CHECK), `match_count`,
    `last_calibrated_at`, `attempts`, attribution, timestamps.
  - `bureau_window_leases`: `id`, `window_target`, `dispatch_id` FK,
    `status` (`active|released|expired|reaped` CHECK), `acquired_at`,
    `expires_at`, `heartbeats`, attribution, timestamps — with a partial
    UNIQUE index on `(window_target)` WHERE `status = 'active'` so the
    database itself refuses double-leasing.
  - `bureau_observations`: `id`, `dispatch_id` FK, `nonce` (UNIQUE),
    `selector_key`, `observed` JSON, attribution, `created_at`.
- **New job kinds frozen**: `junior.dispatch`, `selector.calibrate`,
  `lease.reap`.
- **New span kinds**: `dispatch`, `observation` (added to `SPAN_KINDS`).
- **Shared pure functions in the contract**: `mintNonce()`,
  `isCorrelated(span, observation)` (exact nonce equality), and
  `leaseIsExpired(lease, nowMs)` (pure time math, testable without
  clocks).
- **Contract tests** (`test/unit/contract_c0.test.ts`): schema migration
  from a Phase 2 database, partial-index exclusivity (second active lease
  on the same window refused by the DB), nonce uniqueness, pure-function
  units, seam override semantics.

## 3. Stream A — CDP client & window lease (Junior A: `engine/harness/`)

| # | Deliverable | Acceptance |
|---|---|---|
| A1 | CDP client: launch/attach over the DevTools HTTP + WebSocket endpoints, `navigate`, `read`, `act`, `snapshot`, `close`; converts CDP errors into harness errors with the target attached | T30; real browser in a temp profile, cleaned up in `finally` |
| A2 | Window lease manager: acquire (DB-refused if active), heartbeat extension, explicit release, and a `lease.reap` job that expires dead leases transactionally | T31; mutation: delete the acquire guard, watch T31 fail |
| A3 | `junior.dispatch` job plumbing: marks `bureau_dispatches` running under a lease, drives the driver through the seam, records completion; idempotent on re-run after crash (lease reaped, dispatch re-driven or failed cleanly) | T37 crash test |

## 4. Stream B — selector registry, calibration gate, nonce correlation (Junior B: `engine/selectors/`)

| # | Deliverable | Acceptance |
|---|---|---|
| B1 | Selector registry: register/update/read selectors; `selector.calibrate` job observes the fixture page N times (default 3), requires `matchCount === 1` on every read, sets `calibrated` or `failed` with evidence | T32, T33 |
| B2 | The gate: `read`/`act` refuse any selector not `calibrated`, journal a `guardrail` span, never touch the driver | T35; mutation: delete the gate check, watch T35 fail |
| B3 | Nonce correlation: every driver call inside a dispatch mints a nonce, journals a `dispatch` span, and writes the DOM observation row under the same nonce; a correlation query reconstructs dispatch → actions → effects | T34 |

## 5. Milestone CX — integration (both)

Merge order: C0 → A1–A3 → B1–B3 → CX. Real CDP client + real registry and
gate; the fake driver retired for these tests. The dispatched "junior" is
the mock model with a scripted decision sequence over a local fixture IDE
page (a file with a textarea and buttons is enough).

Exit tests (`test/integration`, numbering continues from T29):

- **T30** — the CDP client launches a local headless browser, navigates a
  `file://` page, reads the DOM, and closes it without leaking processes.
- **T31** — lease exclusivity: a second dispatch on a leased window is
  refused by the database; heartbeat extends; expiry releases; reaping is
  transactional.
- **T32** — a selector with exactly one stable match calibrates after N
  consistent reads.
- **T33** — an ambiguous selector (0 or 2+ matches) fails calibration with
  evidence recorded.
- **T34** — nonce correlation: journal spans and observation rows pair 1:1
  by exact nonce; the correlation query returns the full chain attributed.
- **T35** — the gate: an uncalibrated selector's `act` is refused, the
  browser never sees it, a guardrail span is written.
- **T36** — end-to-end: dispatch → lease → scripted junior edits the
  fixture page through calibrated selectors → observations correlate →
  dispatch completes → lease released.
- **T37** — crash safety: kill the runner mid-dispatch; the lease is reaped
  exactly once, the nonce chain has no orphans, no browser process leaks.
- **T38** — `npm run demo:phase3` mirroring the Phase 2 demo: temp
  everything, journal printed, no fail spans, all processes cleaned up.

## 6. Explicitly out of scope for Phase 3

The Senior's review gates, operator approval UI, PR creation and merge
(Phase 4); watchdog, backup push automation, Secretary, dashboards, the
full red-team sweep (Phase 5); real junior model prompts beyond the scripted
mock (tuned in Phase 4 alongside plan review); anything touching a website
that is not `file://` fixtures.
