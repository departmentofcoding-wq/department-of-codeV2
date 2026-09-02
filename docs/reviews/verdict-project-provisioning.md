# Senior Verdict — Self-serve project provisioning, Stream A (task `6490336d`)

- **Branch / tip reviewed:** `wt/junior-a-project-provisioning` @ `dac626d`
  (base `main` = `c398e7d`; commits `1918ce1` junior WIP secured verbatim,
  `7e25e53` operator-side fix round, `dac626d` test strengthening + mutation
  evidence)
- **Reviewer:** claude senior (`senior-engineer/claude`), driven headless via
  `runWorkReviewCycle` with `CLAUDE_SENIOR_TIMEOUT_MS=600000`
- **Review rounds:** 4 of ceiling 5 (round 1 junior walkthrough → REVISE
  [dead actor guard]; round 2 fix → REVISE [same, junior handoff still dead
  code]; round 3 operator-side fix → REVISE [mutation evidence missing]; round
  4 with M-PROV-1..4 recorded → **APPROVE**)
- **DB review rows:** round 2 `b2dda492…`, round 3 `4c94c74a…`,
  round 4 (approve) `f57bc99f-e42d-4265-8f9f-b4b01f6ad932`
- **Walkthrough artifact:** `docs/junior-artifacts/6490336d-9aec-44d6-9d23-b8e06bc062b5/operator-fix-round-3/walkthrough.md`

## Verdict (round 4, verbatim)

> **VERDICT: APPROVE**
>
> I read the actual diff (`c398e7d..wt/junior-a-project-provisioning`, tip
> `dac626d`) against the task spec, not just the walkthrough's prose, and
> every claim checks out:
>
> - **Schema/config** (`schema.ts`, `constants.ts`, `config.ts`):
>   `github_url`/`provisioned_by`/`visibility` added both to fresh-create DDL
>   and `ADDED_COLUMNS` boot-migration; `PROJECT_META_KEYS`,
>   `PROVISION_ACTOR_ROLES`, `project-provisioned` span kind,
>   `project.provision` job kind all present exactly as spec'd.
> - **`provisionProject`** (`engine/projects/provision.ts`): actor allowlist
>   is a real check (I confirmed the round-2 `if (false as boolean)` dead-code
>   bug is gone), public-visibility gate is operator-only,
>   slug/reserved-name/traversal/case-insensitive-collision checks run before
>   any filesystem write, path containment uses `path.relative` + `..`/
>   absolute checks, remote creation (`repoProvider.createRemote`) happens
>   strictly before `registerProject` — so a thrown `ProvisionError` from the
>   fake/real provider leaves zero DB rows. Registration is routed through the
>   pre-existing `registerProject` (single-sourced UNIQUE/on-disk/git-repo
>   checks), matching the round-3 fix claim.
> - **Job system**: `projectProvisionJobId` is deterministic
>   (`project.provision:<lowercased-trimmed-canonical>`),
>   `defineJob('project.provision', ...)` wired with `maxAttempts: 3`.
> - **CLI** (`scripts/project.ts`): `create` subcommand enqueues via
>   `enqueueJobIfAbsent` + `drainSingleJob` (both pre-existing, reused
>   correctly, not reimplemented).
> - **Tests** (`tc_project_provisioning.test.ts`, 9 tests): I read all 337
>   lines — T-PROV-1 through T-PROV-9 actually assert what the walkthrough
>   claims, including the case-insensitive collision, the
>   clean-scaffold-adoption retry path, the no-orphan-row failure-honesty
>   check, and a whole-DB regex secret scan across all four tables.
>   `FakeRepoProvider` is a clean network-free seam.
> - **Mutation evidence** (`docs/mutation-evidence-phase7.md`, Stream
>   addendum): M-PROV-1..4 target the exact guard lines I read in
>   `provision.ts` (containment, actor allowlist, public gate, registration
>   ordering), and the doc honestly notes a discarded invalid mutation
>   attempt rather than hiding it.
>
> Declared residuals (schema still admits `'internal'` visibility, URL
> constructed rather than parsed from `gh` output, 60s job timeout, CLI
> `--actor` cast `as any`, duplicate `setRepoProvider` alias) are all real but
> genuinely non-blocking — they're honestly disclosed, none violate an
> acceptance criterion, and the actor-authorization gate (the thing that
> actually matters for security) is enforced in the engine regardless of what
> the CLI passes through.
>
> One thing I couldn't do live: the sandbox's directory-change guard blocked
> me from re-running `npx vitest` inside the worktree myself, so I'm relying
> on static code+test inspection (which was thorough) rather than a fresh
> green run. Worth having the next session re-run the suite there before final
> merge if that matters to you, but nothing I read suggests it wouldn't pass.

## Operator verification of the senior's caveat

The senior couldn't re-run the suite in its sandbox. Verified otherwise:

- Full suite on the fix tip `7e25e53`: **488/488 twice, `npm run build`
  clean** (operator-side session).
- On final tip `dac626d` (delta: one strengthened test + docs), the
  **department's own verifier** ran `npx vitest run && npm run build` in the
  worktree as `verify.run` and recorded **exit 0** — task transitioned to
  `needs-review` through the tracked path (first harness-junior task to do
  so; see the ledger entry).
