# Plan — Self-serve Project Provisioning (folder + GitHub repo)

Status: **operator decisions CONFIRMED 2026-08-26** (see below); authored
2026-08-26 at `main` = `c398e7d` (suite 479/479, build clean; one known t4
parallel-load flake re-ran green). Like `docs/plan-bureau-kernel-roadmap.md`,
this file is deliberately untracked — committing it is the operator's
decision, through the normal flow. Nothing here changes a law: merge
discipline, review loop, and mutation-evidence rules stay absolute for every
stream this plan spawns. Stream A is being driven through the live department
machinery as a drill (intake → plan review → junior implementation), per the
operator's request.

## What this is

Today "adding a project to the department" means the operator does four manual
things outside the machinery: `mkdir` a folder somewhere, `git init`, create a
GitHub repo by hand, then paste the path into the console's Add-Project modal
(`POST /api/projects` → `registerProject`, which requires an already-existing
on-disk git repo). Juniors and seniors cannot self-serve, and none of the
manual steps leave a journal trace.

This plan closes that gap with one tracked flow:

> **`project.provision`** — any department engineer (junior, senior, or
> operator) requests a project by name; the bureau creates the folder under a
> single configured **projects root** (default `D:\projects`), initializes it
> as a git repo with an initial commit, creates the GitHub repo in the bureau
> account (`departmentofcoding-wq`) via the already-installed `gh` CLI, pushes,
> and registers it in `bureau_projects` — every step journaled, retries
> bounded, nothing fire-and-forget.

## Exit sentence

> "A junior asks for a project by name; minutes later there is a folder under
> the projects root, a private GitHub repo in the bureau account with the
> initial commit pushed, a `bureau_projects` row, and a journal that says who
> asked, what was created, and what was refused — with zero manual git or
> GitHub UI actions."

## Grounding in the tree (what already exists and is reused)

- `engine/projects/manager.ts` — `registerProject` (on-disk dir + git-repo
  gate, `.bureau-worktrees/` gitignore, `bureau_projects` insert,
  `project-registered` span). **Unchanged**; provisioning ends by calling it.
- `engine/delivery/gh_cli_pr_provider.ts` — the department already shells out
  to `gh` (`execFileSync`, args array, no shell) for PRs. `gh.exe` is installed
  at `C:\Program Files\GitHub CLI\gh.exe`; origin is
  `https://github.com/departmentofcoding-wq/department-of-codeV2.git`, so `gh`
  auth targets the bureau account already. **No new token storage** — `gh`
  owns its credential; bureau code never sees key material (key-hygiene law
  preserved by construction).
- `engine/jobs/registry.ts` + `engine/jobs/ids.ts` — `defineJob` with zod
  payload, deterministic ids (`plan.cycle:<taskId>` precedent), attempts
  budgets; the console and `npm run runner` both drain jobs.
- `engine/llm/google_keys.ts` — the secrets pattern (env + gitignored file +
  masked status + whole-DB scan test) — **not needed for the gh-token path**,
  but referenced if an explicit-token fallback is ever added.
- `engine/db/schema.ts` — `ADDED_COLUMNS` boot-migration door for new nullable
  columns; `engine/contract/constants.ts` holds the closed `SPAN_KINDS` list.
- `scripts/project.ts` — CLI (`register|list|show`), attribution
  `human-operator` hardcoded; gains a `create` subcommand.

## Operator decisions — CONFIRMED 2026-08-26

1. **Projects root path: `D:\projects`** (created on first use if absent).
   Configurable via Settings/`bureau_meta` key `projects_root`.
2. **GitHub owner: `departmentofcoding-wq`.** Verified this session:
   `gh auth status` → logged in, active, token scopes include `repo` (keyring
   credential, bureau code never sees it).
3. **Visibility policy: private by default.** Juniors and seniors may create
   **private** repos only; making a repo **public** is a
   `human-operator`-only act (same spirit as the phone-approval gate —
   publishing is an external-facing, hard-to-reverse action).
4. **Repo/folder naming: prefix `dept-`.** Every provisioned project gets the
   prefix so bureau-created repos are discernible in the GitHub account. The
   prefixed name is **canonical everywhere** — folder name, GitHub repo name,
   and the `bureau_projects.name` row — keeping folder↔repo↔row 1:1 and
   making collision checks uniform. Prefix is configurable via `bureau_meta`
   key `repo_prefix` (default `dept-`); a requested name that already starts
   with the prefix is **not** double-prefixed. Slug validation applies to the
   full prefixed name. The register-existing path (manual) is unaffected — no
   prefix is forced on repos the operator registers by hand.
5. **Supervised convergence run: yes.** First live `gh repo create` happens
   with the operator watching (scratch repo, private, deleted after).

## Design

### 1. Provisioning flow (`engine/projects/provision.ts`, new)

`provisionProject(db, input)` — pure-orchestration, every external effect
behind a seam:

1. **Validate the request.** The requested name must slug-validate
   (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no path separators, no `..`, not a
   Windows reserved name); the **canonical name** is then
   `<repo_prefix><requested>` (default `dept-<requested>`, no double-prefix if
   already prefixed), and collision checks run case-insensitively against
   existing `bureau_projects` names AND existing folders under the root —
   Windows filesystems are case-insensitive. Description optional, capped
   length. Visibility `private` (default) | `public`.
2. **Authorize the actor.** `PROVISION_ACTOR_ROLES = ['junior-engineer',
   'senior-engineer', 'human-operator']`; anything else (intake-officer,
   verifier, scheduler, …) is refused with a `guardrail` span. `public`
   visibility additionally requires `human-operator`.
3. **Resolve and contain the path.** Target = `<projects_root>/<name>`; the
   resolved path must sit strictly inside the configured root (path-containment
   check — the traversal guard, mutation-proven). Root comes from
   `bureau_meta` key `projects_root` (fallback default `D:\projects`), set via
   Settings/CLI with the same validation.
4. **Create local repo.** Refuse if the folder exists and is not adoptable.
   Adoptable = exists, is an empty dir or a git repo with **zero commits and no
   `origin` remote** (a previous attempt's leftovers). Otherwise `mkdir -p` →
   `git init -b main` → write `.gitignore` (`/.bureau-worktrees/`) → initial
   commit (`chore: bureau project scaffold`). All git via `execFileSync`
   args-array (no shell interpolation of the name).
5. **Create the GitHub repo** behind a **`RepoProvider` seam** (new,
   `engine/projects/repo_provider.ts`, mirroring the `PrProvider` pattern):
   `GhCliRepoProvider.createRemote({ name, owner, visibility, sourcePath })` →
   `gh repo create <owner>/<name> --private|--public --source <path> --remote
   origin --push`, returning `{ url }`; failures surface as typed
   `ProvisionError` with the gh stderr tail. The seam is override-able in
   tests (fake provider; **no network in tests — the law**).
6. **Register.** Call the existing `registerProject` unchanged (its gates
   re-verify the repo on disk), then stamp the new columns (`github_url`,
   `provisioned_by`, `visibility`) and write the `project-provisioned` span
   `{ projectId, name, path, githubUrl, visibility, requestedBy }`.
7. **Failure honesty.** Any step failing throws; the **job** machinery handles
   retry (folder adoption in step 4 makes retries idempotent). After
   `max_attempts`, the job is `failed` with a `guardrail` span naming exactly
   which step died and what was left on disk. Registration happens **only
   after** the remote exists — no `bureau_projects` row can point at a repo
   with no GitHub home unless the flow fully succeeded.

### 2. Job kind `project.provision`

- Payload (zod): `{ name, description?, visibility }`; attribution rides the
  enqueueing call into the spans.
- Deterministic id `project.provision:<name>` (`engine/jobs/ids.ts` pattern,
  INSERT OR IGNORE) — double-requests are idempotent by construction.
- `max_attempts: 3`, generous `timeoutMs` (gh network call).
- Enqueued by: the console endpoint, the CLI, or a junior/senior session.
  The console's background Runner drains it; the CLI drains inline (intake-CLI
  precedent) and re-reads the job row to surface non-`done` as a visible error.

### 3. Schema + contract (D0)

- `bureau_projects` new nullable columns via `ADDED_COLUMNS`:
  `github_url TEXT`, `provisioned_by TEXT`, `visibility TEXT`.
- `BureauProjectRow` / new `ProvisionProjectInput` in `engine/contract/types.ts`.
- `SPAN_KINDS` += `project-provisioned` (refusals reuse existing `guardrail`).
- `JOB_KINDS` += `project.provision`.
- `bureau_meta` keys `projects_root` (default `D:\projects`) and `repo_prefix`
  (default `dept-`) (read/write helpers follow the A5 `setModelPrice`
  precedent).
- Console `ENDPOINTS` 30 → 32 (`POST /api/projects/provision`,
  `GET /api/settings/github`); `contract_d0_c` updated in the same freeze.

### 4. Console UX (`console/`)

- Add-Project modal gains two modes: **Register existing folder** (today's
  fields, unchanged path) and **Create new** (name, description, visibility
  select) → `POST /api/projects/provision` → `202 { jobId }`; the Projects tab
  shows a "provisioning…" chip while the job runs (poll job state) and the
  GitHub URL column once provisioned.
- Settings: **Projects root** field (validated, writes `bureau_meta`) and a
  **GitHub connection** card — `GET /api/settings/github` shells
  `gh auth status` and returns only `{ authenticated: boolean, login: string,
  scopes: string[] }` (masked-safe; never token material).

### 5. CLI (`scripts/project.ts`)

`npm run project create -- --name <n> [--description <d>] [--public]
[--actor junior-engineer|senior-engineer|human-operator]` — default actor
`human-operator`; enqueues `project.provision`, drains inline, prints the
folder path + repo URL. Existing `register|list|show` untouched.

### 6. Junior/senior access path

Juniors and seniors reach the flow the same way every department act does:
the engine function and the job accept their attribution, and the allowlist in
step 2 admits them. A junior session (harness or a filed task) runs the CLI
with `--actor junior-engineer`, or a future intake-officer verb can enqueue
the job — the permission lives in the engine, not the front door, so every
entry path gets the same refusal behavior.

## Streams

**Stream A — engine core** (`wt/junior-a-project-provisioning`): contract
columns + span/job kinds, `projects_root` meta helpers, `provision.ts` with
all guards, `RepoProvider` seam + `GhCliRepoProvider`, job registration, CLI
`create`. Unit tests with a fake provider on temp dirs.

**Stream B — console** (`wt/junior-b-project-provisioning`): the two
endpoints, modal modes, provisioning chip + GitHub URL column, Settings cards.
API tests against a fake-seam server (tc7-style).

**Convergence (supervised, operator activity):** with `gh auth status` green,
create one real repo (suggest a scratch name, private) through the console,
watch the job drain, confirm folder + GitHub repo + row + spans, then delete
the test repo. This is the first live network path — fakes prove everything
else.

## Tests + mutation evidence (recorded in `docs/mutation-evidence-phase<N>.md`)

- Slug/refusals: traversal (`../x`), absolute path, separators, reserved
  names, case-insensitive collisions (DB and disk), over-length.
- Prefix behavior: `website` → canonical `dept-website` in folder, repo name,
  and DB row; `dept-website` requested → NOT double-prefixed; changed prefix
  respected from `bureau_meta`.
- Path containment: a projects-root escape attempt is refused.
- Happy path (fake provider): folder + `.gitignore` + initial commit + row +
  `project-provisioned` span with full detail.
- Idempotency: same name re-requested → same deterministic job id, no second
  execution; adoptable-folder retry path; non-adoptable existing folder
  refused.
- Remote failure → attempt 1 fails (attempts=1), retry succeeds; exhaustion →
  job `failed` + `guardrail` span, no `bureau_projects` row.
- Actor allowlist: `verifier`/`intake-officer` refused; `public` refused for
  `junior-engineer`, allowed for `human-operator`.
- Key hygiene: whole-DB + journal scan asserts no `ghp_`/`github_pat_`
  patterns anywhere (belt-and-braces even though the token never transits
  bureau code).
- Console: `202 + jobId`, settings/github masked shape, ENDPOINTS contract.
- Mutations: **M-PROV-1** remove path-containment guard → traversal test
  fails; **M-PROV-2** remove actor allowlist → refusal test fails;
  **M-PROV-3** remove public-visibility gate → its test fails; **M-PROV-4**
  make registration precede remote creation → failure-path test fails (no-row
  invariant).

## Laws preserved (explicitly)

- No secrets in DB/journal/messages/logs — the gh credential stays inside
  `gh`; bureau code passes only names/paths/flags (args-array exec, no shell).
- No network in tests — `RepoProvider` seam faked; gh path only touched in
  the supervised convergence run.
- Every async step is a job row; attempts are a budget column incremented
  transactionally.
- One journal door; refusals and failures are `guardrail` spans, success is
  `project-provisioned`, all attributed.
- Verify commands remain bureau-owned; nothing here reads from workspaces.
- Merge law: streams build on `wt/*` branches, Senior verdict before any
  merge, operator merges. This plan doc itself stays untracked until the
  operator commits it through the flow.

## Out of scope (recorded, not forgotten)

- GitHub org/team permissions, branch protection, README templating beyond
  the initial commit.
- Backup-push wiring for new projects (they get `origin`, so `backup.push`
  works — but scheduling it per-project is a follow-up).
- Provisioning *departments* (Phase 10's `scaffold` flow) — that is the
  kernel's instantiation path; this plan only automates plain project repos.
  If Phase 9/10 extract the kernel, `RepoProvider` is already seam-shaped to
  travel with it.
