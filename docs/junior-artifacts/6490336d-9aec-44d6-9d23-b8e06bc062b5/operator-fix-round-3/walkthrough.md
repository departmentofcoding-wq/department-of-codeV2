# Walkthrough — Stream A: self-serve project provisioning (round 3)

**Authorship, stated honestly:** rounds 1–2 (implementation + first fix) were
junior A (Antigravity). Its IDE became unavailable (operator closed it for PC
load), so the operator-side session applied this round-3 fix set directly on
the same branch. The junior's round-2 handoff was committed verbatim at
`1918ce1`; the round-3 fixes are `7e25e53`. Both sit on
`wt/junior-a-project-provisioning`, cut from `main` = `c398e7d`.

## What this stream delivers

`project.provision` — a tracked, journaled, retryable job that lets any
department engineer (junior-engineer, senior-engineer, human-operator) request
a project by name; the bureau creates `<projects_root>/<canonical>` (canonical
= `dept-` prefix, no double-prefix), git-inits it with `.gitignore`
(`/.bureau-worktrees/`) + README + initial commit, creates the GitHub repo via
`gh repo create --source --push` behind a fake-able `RepoProvider` seam, and
registers it through the EXISTING `registerProject`.

- `engine/projects/provision.ts` — guarded orchestration: actor allowlist
  (`PROVISION_ACTOR_ROLES`), public-visibility operator-only gate, slug +
  reserved-name + traversal refusal, case-insensitive DB/disk collision
  checks, path containment inside the projects root, clean-scaffold folder
  adoption for retries, remote-before-registration ordering (no DB row can
  exist for a failed remote), `project-provisioned` span.
- `engine/projects/repo_provider.ts` — `GhCliRepoProvider` (args-array
  execFileSync, typed `ProvisionError` with gh stderr tail) + override seam.
- `engine/projects/config.ts` — `projects_root` / `repo_prefix` /
  `github_owner` meta helpers; defaults `D:\projects` (operator-confirmed
  2026-08-26), `dept-`, `departmentofcoding-wq`.
- Contract/schema: `bureau_projects` += `github_url`, `provisioned_by`,
  `visibility` (fresh-create + `ADDED_COLUMNS` boot-migration); span kind
  `project-provisioned`; job kind `project.provision` (deterministic id
  `project.provision:<canonical>`, maxAttempts 3).
- CLI: `npm run project create -- --name <n> [--description] [--public]
  [--actor]` — enqueue + inline drain + result printout.

## Round-3 changes (this fix set — the senior's round-2 REVISE + operator review)

1. **Actor guard restored** (`provision.ts`): the round-2 handoff had the
   allowlist gated behind `if (false as boolean)` — dead code; T-PROV-5 was
   red at handoff. Now a real check:
   `!actorRole || !PROVISION_ACTOR_ROLES.includes(actorRole)` refuses with a
   `guardrail` span (`actor_not_authorized`). **T-PROV-5 now passes.**
2. **Projects-root default** (`config.ts`): was `<repoRoot>/projects`; now
   `D:\projects` per the operator's confirmed decision (meta/env overrides
   unchanged; tests set meta to temp dirs, so they never touch the default).
3. **Registration routed through `registerProject`** (`provision.ts`): the
   raw INSERT bypass is gone; the existing gate (on-disk dir + git-repo
   re-verification, UNIQUE handling, `project-registered` span) is
   single-sourced. `provisioned_by` records the requesting actor role.

## Verification (operator-side session, on the branch tip `7e25e53`)

- `npx vitest run` — **488/488 across 102 files, run TWICE, both green**
  (main baseline was 479/479 + the known t4 parallel flake, which did not
  appear in either run).
- New suite: `test/unit/tc_project_provisioning.test.ts` — 9 tests
  (T-PROV-1…9): happy path, prefix semantics, slug/traversal/reserved/
  collisions, path containment, actor + visibility gates, deterministic job
  id, failure honesty (no row on remote failure), retry/adoption, whole-DB +
  journal secret scan (`ghp_`/`github_pat_` patterns). All against a
  `FakeRepoProvider` — zero network, per the test law.
- `npm run build` (`tsc --noEmit`) — clean.

## Known residuals (declared, not hidden — junior's round-2 shape, non-blocking)

- The job zod schema still admits `'internal'` visibility (undefined in the
  design; the provider maps anything non-public to `--private`).
- `GhCliRepoProvider` constructs the repo URL rather than parsing gh's output.
- Job `timeoutMs` is 60s — tight for a slow `gh` network call.
- `scripts/project.ts` `--actor` is cast `as any` (the engine allowlist is the
  real gate now, but the CLI could validate earlier).
- Duplicate `setRepoProvider`/`setRepoProviderOverride` aliases in
  `repo_provider.ts`.

## Not yet done (out of this stream's scope, per plan)

- Console UX (Stream B: modal "Create new" mode, `POST /api/projects/provision`,
  Settings cards) — separate stream.
- Mutation evidence M-PROV-1…4 not yet executed/recorded — required before
  merge per department law; the operator will run them against `7e25e53`.
- The live supervised `gh repo create` convergence run (operator activity).

---

## Round-4 addendum — mutation evidence executed (closes the senior's only blocker)

Recorded in `docs/mutation-evidence-phase7.md` (worktree copy, same commit):

| Id | Mutation | Caught by | Result |
|---|---|---|---|
| M-PROV-1 | containment guard → `if (false)` | T-PROV-4 | RED (1 failed), restored → 9/9 |
| M-PROV-2 | actor allowlist → `if (false as boolean)` | T-PROV-5 | RED (1 failed), restored → 9/9 |
| M-PROV-3 | public gate → `if (false as boolean)` | T-PROV-5 | RED (1 failed), restored → 9/9 |
| M-PROV-4 | registration moved before remote | T-PROV-7 (+T-PROV-1/8) | RED (3 failed), restored → 9/9 |

Also strengthened T-PROV-4 with a `repoPrefix:'../evil/'` vector — the only
input the containment guard uniquely catches (the `name:'..'` assertion was
redundantly caught by the slug guard first; recorded honestly). One invalid
mutation attempt (compile-error surgery) was discarded and redone cleanly.
