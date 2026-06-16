# Plan 001: Compute Gallery Derived State Once

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report - do not improvise. When done, update the status
> row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c328a78..HEAD -- apps/pane-view/src/features/gallery/GalleryPage.tsx`
> If this reports changes, compare the "Current state" excerpts below against the live code before
> proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `c328a78`, 2026-06-17

## Why this matters

`GalleryPage` currently derives the same gallery view twice: once in the parent component for
selection/navigation/viewer state, and again in `GalleryBrowsePane` for rendering the grid. The
work includes sorting all loaded media, filtering by media-type settings, building comic groups,
and building `BrowserEntry` rows. Virtualization only limits mounted cards; this duplicated
derivation still scales with every loaded media page.

This plan keeps behavior the same but moves the existing derived values through props so each
render does the expensive work once.

## Current state

Relevant files:

- `apps/pane-view/src/features/gallery/GalleryPage.tsx` - owns gallery state, media pagination,
  selection, and the grid pane.

Current duplicate derivation in the parent:

```tsx
// apps/pane-view/src/features/gallery/GalleryPage.tsx:245
const sortedMedia = useMemo(
  () => (allMedia.length > 0 ? sortMediaItems(allMedia, sortMode, randomSeed) : []),
  [allMedia, randomSeed, sortMode],
);
const filteredMedia = useMemo(
  () =>
    sortedMedia.filter((item) => {
      if (item.mediaType === "video" && !settings.showVideos) {
        return false;
      }
      if ((item.mediaType === "image" || item.mediaType === "gif") && !settings.showImages) {
        return false;
      }
      return true;
    }),
  [settings.showImages, settings.showVideos, sortedMedia],
);
```

Current duplicate derivation in the pane:

```tsx
// apps/pane-view/src/features/gallery/GalleryPage.tsx:1297
const sortedMedia = useMemo(
  () => sortMediaItems(media, sortMode, randomSeed),
  [media, randomSeed, sortMode],
);
const visibleMedia = useMemo(
  () =>
    sortedMedia.filter((item) => {
      if (item.mediaType === "video" && !settings.showVideos) {
        return false;
      }
      if ((item.mediaType === "image" || item.mediaType === "gif") && !settings.showImages) {
        return false;
      }
      return true;
    }),
  [settings.showImages, settings.showVideos, sortedMedia],
);
```

The pane also rebuilds comics and entries:

```tsx
// apps/pane-view/src/features/gallery/GalleryPage.tsx:1316
const comics = useMemo(() => {
  if (!comicMode) {
    return [];
  }

  const groupedComics = buildComicEntries(visibleMedia, displayPath || null, {
    folders: library.allFolders,
    leafFoldersOnly: true,
  });
  return sortComicEntries(groupedComics, sortMode, randomSeed);
}, [comicMode, displayPath, library.allFolders, randomSeed, sortMode, visibleMedia]);
const entries = useMemo(
  () =>
    buildBrowserEntries({
      folders: library.folders,
      comics,
      items: visibleMedia,
      recursive: effectiveRecursive,
      comicMode,
      sortMode,
    }),
  [comicMode, comics, effectiveRecursive, library.folders, sortMode, visibleMedia],
);
```

Repo conventions to match:

- TypeScript ESM, React function components, 2-space formatting, named exports.
- Keep gallery feature code inside `apps/pane-view/src/features/gallery/`.
- Use existing `useMemo` style rather than introducing a new state library.
- Preserve documented vocabulary from `CONTEXT.md`: use "Pane View", "Delivery Token",
  "Image Delivery", and "Derivative Queue" when naming any new code or comments.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck Pane View | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |
| Focused gallery tests | `pnpm --filter @latch-works/pane-view test -- src/features/gallery` | exit 0, existing gallery tests pass |
| Full Pane View check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**:

- `apps/pane-view/src/features/gallery/GalleryPage.tsx`
- Optional: `apps/pane-view/src/features/gallery/gallery-derived-state.ts`
- Optional: `apps/pane-view/src/features/gallery/gallery-derived-state.test.ts`

**Out of scope**:

- Server query behavior.
- Pagination size, cursor behavior, or API response shapes.
- Styling changes.
- Media delivery, thumbnail, or optimizer code.

## Git workflow

- Branch: `codex/001-dedupe-gallery-derived-state`
- Commit message style: short imperative, for example `Dedupe gallery derived state`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Choose the smallest derivation boundary

In `GalleryPage.tsx`, keep the parent-owned derived values as the source of truth:

- `sortedMedia`
- `filteredMedia` / `visibleMedia`
- `navigableMedia`
- `comics`
- `entries`

Prefer passing `entries` and `visibleMedia` into `GalleryBrowsePane` rather than having the pane
re-read the same query and rebuild them.

If the prop list becomes hard to read, create a small pure helper in
`gallery-derived-state.ts`, but do not introduce new behavior.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> it may fail until Step 2 is
complete, but any errors should be limited to the props you are actively changing.

### Step 2: Remove duplicate derivation from `GalleryBrowsePane`

Update `GalleryBrowsePaneProps` so the pane receives already-built data:

- `entries: BrowserEntry[]`
- `visibleMedia: LibraryMediaItem[]` only if still needed by the pane
- `folders` / `allFolders` should not be needed in the pane after entries are passed.

Remove the pane-local call to `useLibrarySnapshotSuspense(snapshotRequest)` unless another live
use remains. Remove pane-local `sortMediaItems`, media filtering, `buildComicEntries`,
`sortComicEntries`, and `buildBrowserEntries`.

The parent should still use `useLibrarySnapshotQuery(snapshotRequest)` once near the top of
`GalleryPage`.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Keep selection, viewer, and thumbnail behavior unchanged

Confirm these behaviors still consume the same parent-derived arrays:

- `selected`, `selectedIndex`, and adjacent navigation use `visibleMedia` / `navigableMedia`.
- `openViewer` still receives the same visible media list.
- `BrowserGrid` still receives `entries`.
- `handleWindowedEntriesChange` still receives windowed entries from `BrowserGrid`.

Do not change `BrowserGrid` virtualization logic.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/features/gallery` -> exit 0.

### Step 4: Add a regression test only if you extracted a helper

If you created `gallery-derived-state.ts`, add `gallery-derived-state.test.ts` covering:

- media type filtering respects `showImages` and `showVideos`;
- comic mode groups image/gif pages and omits raw media entries;
- non-comic mode includes media entries and folder entries.

Use `packages/media-domain/src/media.test.ts` as the data-shape pattern.

If you did not extract a helper, do not create a brittle component test just for this refactor.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/features/gallery` -> exit 0.

## Test plan

- Run existing gallery tests.
- If a pure helper is introduced, add focused unit tests for the helper.
- Run Pane View typecheck and check.

## Done criteria

- [ ] `pnpm --filter @latch-works/pane-view typecheck` exits 0.
- [ ] `pnpm --filter @latch-works/pane-view test -- src/features/gallery` exits 0.
- [ ] `pnpm --filter @latch-works/pane-view check` exits 0.
- [ ] `GalleryBrowsePane` no longer calls `sortMediaItems`, `buildComicEntries`, or
      `buildBrowserEntries`.
- [ ] `git diff --stat` shows only in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The current duplicate derivation locations no longer match the excerpts.
- Removing `useLibrarySnapshotSuspense` from `GalleryBrowsePane` changes route loading behavior or
  causes a Suspense fallback loop.
- The change appears to require touching server query code.
- Verification fails twice after reasonable fixes.

## Maintenance notes

This is intentionally a small cleanup before larger server-owned gallery listing work. If Plan 004
lands later, this plan still helps because there will be one obvious place in `GalleryPage` where
derived listing data enters the UI.
