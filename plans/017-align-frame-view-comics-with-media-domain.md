# Plan 017: Align Frame View Comics With Media-Domain

> **Executor instructions**: Run the drift check first. Respect Frame View's
> local AGENTS guidance, but do not broaden the extraction beyond comic helpers.
> Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d8f3c52..HEAD -- apps/frame-view/src/renderer/utils/comics.ts apps/frame-view/tests/renderer/utils/comics.test.ts packages/media-domain/src/comics.ts packages/media-domain/src/comics.test.ts apps/frame-view/package.json apps/frame-view/tsconfig.json`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: tech-debt
- **Planned at**: commit `d8f3c52`, 2026-06-28

## Why This Matters

Frame View is the local UX north star for Pane View, but its comic grouping has
drifted from the shared `media-domain` behavior. Frame View excludes GIF pages
and lacks the shared leaf-folder option, so the same archive can group comics
differently in the two viewers.

## Current State

- `apps/frame-view/src/renderer/utils/comics.ts:47-57` only accepts
  `item.mediaType === 'image'`.
- `packages/media-domain/src/comics.ts:35-37` accepts both `image` and `gif`.
- `media-domain/src/comics.ts:13-17` supports `leafFoldersOnly` with folder
  parent paths; Frame View's local copy does not.
- Frame View tests exist at `apps/frame-view/tests/renderer/utils/comics.test.ts`.
- Repo architecture docs say Frame View shared package extraction is planned, but
  this plan fixes the concrete drift only.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Frame View comics tests | `pnpm --filter @latch-works/frame-view test -- comics` | exit 0 |
| Media domain tests | `pnpm --filter @latch-works/media-domain test -- comics` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/frame-view typecheck && pnpm --filter @latch-works/media-domain typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/frame-view/src/renderer/utils/comics.ts`
- `apps/frame-view/tests/renderer/utils/comics.test.ts`
- Optional import of `@latch-works/media-domain` if dependency wiring is already
  safe for Frame View

**Out of scope**:
- Extracting all Frame View utilities.
- Creating `media-ui`.
- Changing Pane View comic behavior.

## Git Workflow

- Branch: `advisor/017-frame-view-comic-parity`
- Commit message: `Align Frame View comic grouping`

## Steps

### Step 1: Add Drift Tests In Frame View

Add Frame View tests for:

- GIF pages are included in comic groups.
- Parent folders with child folders are skipped when leaf-only behavior is used,
  if Frame View has enough folder context at the call site.

If Frame View currently lacks folder context for leaf-only behavior, document that
and implement only GIF parity in this plan.

**Verify**: `pnpm --filter @latch-works/frame-view test -- comics` -> new GIF test fails before implementation.

### Step 2: Choose Minimal Parity Approach

Option A, preferred if dependency wiring is simple: adapt Frame View local item
types and call `buildComicEntries`/`sortComicEntries` from
`@latch-works/media-domain`.

Option B, minimal drift fix: update the local copy to accept `gif` and add the
leaf-only option only if the call site can provide folder data.

Do not migrate unrelated `sort.ts`, `path.ts`, or browser entry helpers here.

**Verify**: `pnpm --filter @latch-works/frame-view typecheck` -> exits 0.

### Step 3: Keep Both Package Tests Green

Run both Frame View and media-domain comics tests. If you chose Option A, ensure
Frame View package resolution still works after building workspace packages.

**Verify**: `pnpm --filter @latch-works/media-domain test -- comics && pnpm --filter @latch-works/frame-view test -- comics` -> exits 0.

## Test Plan

- Frame View test for GIF comic page inclusion.
- Optional Frame View test for leaf-only suppression.
- Existing media-domain comic tests stay unchanged and passing.

## Done Criteria

- [ ] Frame View comic grouping includes GIFs like media-domain.
- [ ] Leaf-folder behavior is either aligned or explicitly deferred because
  Frame View lacks folder context.
- [ ] Focused tests and typechecks exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Importing `media-domain` into Frame View breaks Electron build assumptions.
- Frame View types are incompatible enough to require a broad domain migration.
- Fixing leaf-only behavior requires unrelated folder-browser refactors.

## Maintenance Notes

- This is a narrow parity fix. The broader planned extraction to shared packages
  should still be tracked separately.
