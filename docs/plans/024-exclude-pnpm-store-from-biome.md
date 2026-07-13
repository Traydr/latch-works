# Plan 024: Keep repository-local package stores out of Biome

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report; do not
> improvise. When done, update this plan's row in `docs/plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- biome.json .gitignore package.json`
> Compare the current include list with the excerpt below if any file changed.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 11

## Why this matters

`pnpm lint` currently scans the ignored root `.pnpm-store` and emits thousands of diagnostics from
third-party packages. The failure depends on where pnpm's store is configured, so a clean CI checkout
can pass while a normal local checkout cannot run the documented verification gate. This plan makes
Biome's explicit file traversal agree with the repository's ignored dependency/cache boundaries.

## Current state

- `biome.json:5-13` starts with `"**"` and excludes `node_modules`, build outputs, Frame View, and
  Gather Box, but not `.pnpm-store`.
- `.gitignore:3` already contains `.pnpm-store/`, proving the directory is expected local state.
- `package.json:12` defines `pnpm lint` as `biome check .`; `pnpm check` invokes it.
- Biome is a check-only gate here. Do not run `pnpm format` or any command with `--write`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Reproduce | `pnpm lint` | Before the fix: diagnostics name `.pnpm-store`; after the fix: exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `biome.json` only.

**Out of scope**: formatting source files; suppressing repository-owned diagnostics; changing the
Frame View or Gather Box lint arrangements; moving or deleting `.pnpm-store`.

## Git workflow

- Branch: `codex/024-exclude-pnpm-store-from-biome`
- Commit message: `Exclude local pnpm store from Biome`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add the narrow cache exclusion

Add `!**/.pnpm-store` to `files.includes` beside the other dependency/build exclusions. Do not add a
broad hidden-directory exclusion: `.github`, `.railway`, and other checked configuration must remain
visible to Biome.

**Verify**: `pnpm lint` -> exit 0 and no diagnostic path contains `.pnpm-store`.

### Step 2: Confirm the exclusion did not weaken TypeScript verification

**Verify**: `pnpm typecheck` -> exit 0, no errors.

## Test plan

No new automated test is warranted for a one-line tool include. The regression check is running
`pnpm lint` with `.pnpm-store` present and confirming it exits 0 without traversing that directory.

## Done criteria

- [ ] `pnpm lint` exits 0 with the existing `.pnpm-store` present.
- [ ] `pnpm typecheck` exits 0.
- [ ] `git diff --name-only` lists only `biome.json` and the executor-maintained plan index.
- [ ] The status row in `docs/plans/README.md` is updated.

## STOP conditions

- `pnpm lint` still reports repository-owned diagnostics after `.pnpm-store` is excluded.
- Biome rejects the negative include syntax.
- Fixing the gate appears to require deleting local caches or suppressing source diagnostics.

## Maintenance notes

Review future repo-local caches individually. Exclude generated/dependency state by exact directory
name; do not make Biome ignore all dot-directories.

