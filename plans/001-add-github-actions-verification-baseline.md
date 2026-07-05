# Plan 001: Add GitHub Actions Verification Baseline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report. When done, update this
> plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- package.json pnpm-lock.yaml AGENTS.md .github`
> If any in-scope file changed since this plan was written, compare the current
> state excerpts below against live code before proceeding.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests, dx
- **Planned at**: commit `8f19cd4`, 2026-07-05
- **Pull request**: https://github.com/Traydr/latch-works/pull/47
- **Merged**: 2026-07-05, merge commit `4ffbdb4`
- **Verified**: GitHub `Check` passed on PR #47 and latest `main` check passed
  at https://github.com/Traydr/latch-works/actions/runs/28746243602

## Completion Notes

- Implemented `.github/workflows/check.yml` on `ubuntu-latest` per maintainer
  feedback, using `pnpm/action-setup@v4` before `actions/setup-node@v4` so
  `cache: pnpm` can locate pnpm.
- Installed with `pnpm install --frozen-lockfile --prod=false` and ran the full
  workspace `pnpm check` gate.
- Accepted execution deviation: source/test/config cleanup was included to make
  Biome, Knip, and the full CI gate green.

## Why This Matters

The repository has a strong local check pipeline but no GitHub automation. The
maintainer uses GitHub, so regressions can land unless a human remembers to run
the right commands locally. Several later plans are safer if a stable PR gate is
already in place.

## Current State

- `package.json:8-15` defines root scripts: `build`, `check:packages`, `check`,
  `lint`, `test`, `typecheck`, and `knip`.
- `package.json:10` currently runs `pnpm -r --sort build && pnpm run
  check:packages && pnpm run lint && pnpm run knip`.
- No `.github/workflows/` directory exists.
- `AGENTS.md:103-107` documents current caveats: full `pnpm check` may fail on
  Linux because of Frame View tests, Lockstep CLI missing-field tests require
  sync env vars to be unset, and lint may have pre-existing noise.
- Repo conventions: TypeScript ESM, pnpm 11.1.0, Node 22+, Biome, Vitest.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Full check | `pnpm check` | exit 0 |
| Focused CI dry run | `pnpm test && pnpm typecheck && pnpm lint && pnpm knip` | exit 0 |

## Scope

**In scope**:
- `.github/workflows/check.yml` (create)
- `package.json` only if a new CI-specific script is necessary
- `AGENTS.md` only if you encode caveats differently and need docs to match

**Out of scope**:
- Source code fixes for failing tests or lint, except minimal environment fixes
  needed to make the CI command reproducible.
- Pre-commit hooks. This plan is GitHub CI only.

## Git Workflow

- Branch: `advisor/001-github-actions-verification-baseline`
- Commit message style: short imperative, e.g. `Add GitHub verification workflow`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add A GitHub Workflow

Create `.github/workflows/check.yml`. Use Node 22 and pnpm 11.1.0 through
Corepack. Because the documented Linux caveat affects full `pnpm check`, start
with `macos-latest` for the full workspace gate unless you first make a
Linux-safe `check:ci` script. Include `pull_request`, `push` to the default
branch, and `workflow_dispatch`.

The job should run:

```yaml
pnpm install --frozen-lockfile
pnpm check
```

**Verify**: `pnpm check` -> exits 0 locally on the maintainer platform, or if it
does not, document the exact pre-existing failure in the workflow PR notes and
STOP before weakening the gate.

### Step 2: Make The Gate Reproducible

Ensure CI does not source repo-root `.env`. If Lockstep CLI tests fail because
`LOCKSTEP_API_URL` or `LOCKSTEP_API_TOKEN` is set in the environment, set those
variables to empty only for the test command or add a package-level test setup
that deletes them. Prefer fixing the tests to relying on workflow-only env.

**Verify**: `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test` -> exits 0.

### Step 3: Document The Workflow

If you add a CI-specific script, update `AGENTS.md` build/test commands so future
agents know the canonical GitHub gate. Do not rewrite unrelated setup docs here;
Plan 018 handles local services docs.

**Verify**: `pnpm lint` -> exits 0.

## Test Plan

- This plan adds infrastructure, not product code.
- If test env cleanup is needed, add or update the relevant Lockstep CLI test so
  it passes without relying on shell state.
- Verification: `pnpm check` -> exits 0.

## Done Criteria

- [x] `.github/workflows/check.yml` exists and runs on PRs.
- [x] Workflow uses Node 22 and pnpm 11.1.0.
- [x] The workflow runs `pnpm install --frozen-lockfile --prod=false` and
  `pnpm check`.
- [x] `pnpm check` exited 0 locally and in GitHub Actions.
- [x] Accepted deviation recorded: source/test/config cleanup was needed to make
  the CI gate green.
- [x] `plans/README.md` status row updated.

## STOP Conditions

- GitHub Actions cannot run macOS runners for this repository.
- `pnpm check` exposes broad pre-existing failures unrelated to CI setup.
- Making CI green requires product-code changes outside the scope above.

## Maintenance Notes

- Reviewers should reject a workflow that silently skips major workspaces.
- If later plans add a Linux-safe `check:ci`, move CI to cheaper Linux runners.
