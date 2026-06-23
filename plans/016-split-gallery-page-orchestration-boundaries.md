# Plan 016: Split GalleryPage Orchestration Boundaries

> **Executor instructions**: Run the drift check first. This is a refactor plan;
> preserve behavior and keep changes reviewable. Update `plans/README.md` when
> done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- apps/pane-view/src/features/gallery/GalleryPage.tsx apps/pane-view/src/features/gallery apps/pane-view/src/features/gallery/*.test.tsx`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: tech-debt
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

`GalleryPage.tsx` is the main Pane View gallery orchestrator and is currently a
1,568-line file with many local state variables, effects, helpers, and a nested
`GalleryBrowsePane`. This makes gallery behavior expensive to review and risky
to change. The goal is smaller, named boundaries without changing UI behavior.

## Current State

- `GalleryPage.tsx:81-1350` contains the main `GalleryPage` component.
- `GalleryPage.tsx:97-132` initializes many independent state variables,
  including settings UI, browse modes, selection, viewer state, pagination,
  deletion state, and thumbnail resolution state.
- `GalleryPage.tsx:1352-1511` defines `GalleryBrowsePane` in the same file.
- `GalleryPage.tsx:1513-1568` defines helper functions for media merging and
  thumbnail request dedupe.
- Repo React convention: preserve existing style and do not add `useMemo` or
  `useCallback` broadly except where already needed for behavior.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Gallery tests | `pnpm --filter @latch-works/pane-view test -- gallery MediaViewerModal` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Build | `pnpm --filter @latch-works/pane-view build` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/features/gallery/GalleryPage.tsx`
- New files under `apps/pane-view/src/features/gallery/` for extracted hooks,
  helper functions, and `GalleryBrowsePane`
- Tests for extracted pure helpers/hooks where practical

**Out of scope**:
- Visual redesign.
- Changing URL search params or gallery behavior.
- Replacing TanStack Query/Router patterns.
- SPA conversion. That requires a separate plan.

## Git Workflow

- Branch: `advisor/016-gallery-page-boundaries`
- Commit message: `Split gallery page boundaries`

## Steps

### Step 1: Move Pure Helpers First

Move `mergeLibraryMedia`, `supportsGalleryThumbnail`, `dedupeThumbnailRequests`,
and `areThumbnailRequestsEqual` to a new helper file such as
`gallery-page-helpers.ts`. Export only what `GalleryPage` needs. Add small tests
for dedupe/equality helpers.

**Verify**: `pnpm --filter @latch-works/pane-view test -- gallery-page-helpers` -> exits 0.

### Step 2: Move GalleryBrowsePane Without Behavior Changes

Move `GalleryBrowsePane` and `GalleryBrowsePaneProps` into
`GalleryBrowsePane.tsx`. Keep prop names and JSX unchanged. This should be a
mechanical extraction.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exits 0.

### Step 3: Extract Thumbnail Resolution State

Extract the `windowedThumbnailRequests`, `resolvedThumbnailUrls`, and
`resolvedThumbnailTokens` state/effects into a hook such as
`useWindowedThumbnailResolution`. Keep input/output explicit and do not change
batching behavior.

**Verify**: `pnpm --filter @latch-works/pane-view test -- batched-thumbnail-resolver useResolvedMediaUrl` -> exits 0.

### Step 4: Extract Viewer Handoff State

Extract `viewerOpen`, `viewerItems`, `viewerLockedMediaId`, and related handlers
into a hook such as `useGalleryViewerHandoff`. Preserve URL `media` search sync
and selection behavior.

**Verify**: `pnpm --filter @latch-works/pane-view test -- MediaViewerModal gallery` -> exits 0.

### Step 5: Stop When The File Is Reviewable

Do not attempt to split everything in one PR. The target is to make
`GalleryPage.tsx` primarily an orchestrator under roughly 700 lines. If that is
not achievable after the steps above, stop with the helpers/pane extraction and
record follow-up work.

**Verify**: `pnpm --filter @latch-works/pane-view build` -> exits 0.

## Test Plan

- Unit tests for extracted pure helpers.
- Existing gallery/media viewer tests pass.
- Manual smoke: open gallery, switch recursive/comic modes, select media, open
  viewer, load more, delete entry.

## Done Criteria

- [ ] `GalleryBrowsePane` is in its own file.
- [ ] Pure helpers are outside `GalleryPage.tsx` and tested.
- [ ] At least one state cluster is extracted to a named hook.
- [ ] Gallery behavior and URL search params remain unchanged.
- [ ] Focused tests, typecheck, and build exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Extraction changes visible gallery behavior.
- URL/search-param sync becomes ambiguous.
- The refactor requires broad component redesign or new state management.

## Maintenance Notes

- Keep this refactor mechanical. Future feature work should land after the file
  is smaller, not during this extraction.
