# Plan 033: Reconnect Frame View to the shared media domain

> **Executor instructions**: Characterize Windows and POSIX path behavior before deleting local
> helpers. Run root and standalone Frame verification. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- packages/media-domain/src apps/frame-view/src/renderer/utils apps/frame-view/src/shared apps/frame-view/package.json apps/frame-view/pnpm-workspace.yaml pnpm-lock.yaml apps/frame-view/pnpm-lock.yaml`

## Status

- **Status**: DONE (`30fb5e4`, independently verified 2026-07-13)
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 20

## Why this matters

Frame View duplicates shared sorting, hashing, comic grouping, and path normalization. The copies have
already diverged: Frame accepts only `image` comic pages while `media-domain` also accepts GIFs.
Shared archive behavior should live in `media-domain`, while Frame-specific absolute-path policy stays
behind explicit adapters.

## Current state

- `packages/media-domain/src/sort.ts` and `apps/frame-view/src/renderer/utils/sort.ts` are near copies.
- `packages/media-domain/src/comics.ts:35-38` includes image/GIF; Frame's copy at `:54-57` is image-only.
- Frame has no `@latch-works/media-domain` dependency.
- Frame's nested `pnpm-workspace.yaml` currently lacks package globs; Lockstep's nested workspace shows
  the established pattern for including `../../packages/...`.
- Frame uses single quotes and its own `biome.jsonc`; match local style.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Domain tests | `pnpm --filter @latch-works/media-domain test` | all pass |
| Frame tests | `pnpm --filter @latch-works/frame-view test` | all pass |
| Frame check | `pnpm --filter @latch-works/frame-view check` | exit 0 |
| Root typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: shared sort/comic/path helpers and tests; Frame sort/comic adapters/tests and imports;
Frame manifest/workspace/lockfiles needed for the workspace dependency.

**Out of scope**: PDF support (Plan 040); virtual-grid extraction; replacing Frame's full media type;
gallery visual changes; unrelated dependency upgrades.

## Git workflow

- Branch: `codex/033-reunify-frame-media-domain`
- Commit message: `Share media domain behavior with Frame View`

## Steps

### Step 1: Add golden behavior tests before migration

Create shared/Frame characterization cases for numeric names, random order, Windows absolute paths,
POSIX paths, root exclusion, underscores/hyphens, mixed image/GIF/video folders, and comic covers.
Record the intended policy explicitly: GIFs are comic pages in both viewers unless product docs say
otherwise.

**Verify**: tests demonstrate current divergence only in the cases this plan intends to correct.

### Step 2: Make shared helpers accept minimal structural inputs

Generalize type signatures with `Pick`/small interfaces where Frame's Zod-derived item is structurally
compatible. Add an explicit path adapter/policy for absolute OS paths instead of teaching archive-path
helpers to silently reinterpret them.

**Verify**: media-domain tests pass with no Electron dependency.

### Step 3: Add the workspace dependency in both install modes

Add `@latch-works/media-domain: workspace:*` to Frame and include the package in Frame's nested pnpm
workspace using Lockstep's proven relative-package pattern. Refresh root and nested lockfiles with pnpm;
do not hand-edit resolved versions.

**Verify**: root install/check resolution and an isolated `pnpm --dir apps/frame-view install --lockfile-only`
both succeed without lock drift.

### Step 4: Switch Frame callers and remove superseded copies

Replace local sort/hash/comic code with imports plus only the necessary absolute-path adapter. Preserve
Frame-specific settings and item types. Delete local helpers only after all callers and golden tests
use the shared implementation.

**Verify**: `rg -n 'function hashString|function buildComicEntries' apps/frame-view/src` shows no
duplicated implementation; all focused suites pass.

## Test plan

Model shared cases after `packages/media-domain/src/media.test.ts` and Frame cases after
`tests/renderer/utils/comics.test.ts`. Include Windows separators because Frame's existing tests and
runtime support them.

## Done criteria

- [ ] Frame imports shared sort/comic behavior.
- [ ] GIF comic policy is consistent and tested.
- [ ] Absolute Windows/POSIX path behavior is preserved by an explicit adapter.
- [ ] Root and nested dependency graphs resolve.
- [ ] Domain, Frame, and root typechecks pass.

## STOP conditions

- Nested pnpm workspaces cannot safely reference `../../packages/media-domain`.
- Golden tests reveal intentional product differences not expressible as options/adapters.
- Migration requires replacing Frame's complete IPC media schema.

## Maintenance notes

Shared helpers must remain UI- and Electron-independent. New policy differences should be named
options, not copied implementations.
