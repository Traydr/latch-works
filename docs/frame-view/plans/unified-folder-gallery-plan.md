# Unified Folder + Gallery View Plan

## Summary
Refactor the non-recursive browsing experience so immediate child folders and direct media files can appear together in one grid. This removes the current split between "gallery mode" and the special empty-folder fallback, which breaks down when a directory contains a mix of folders and only a few media items.

## Problem Statement
Today the renderer treats the main content area as media-only and only shows folders when there are zero media items in the current non-recursive folder. That creates several issues:

1. A single media file suppresses folder visibility entirely.
2. Folder navigation feels like a mode switch instead of one browsing workflow.
3. Keyboard selection and top-bar navigation have to special-case folder browsing.
4. The current empty-folder fallback is harder to extend than a unified content model.

## Goals
1. Show immediate child folders and direct media items together in one main grid when recursive mode is off.
2. Keep fullscreen viewer behavior media-only.
3. Preserve parent/previous/next folder navigation in the top bar.
4. Make selection and keyboard behavior consistent across mixed content.
5. Keep recursive mode focused on media results only unless a future feature explicitly expands its scope.

## Non-Goals
1. Showing nested descendant folders beyond the immediate children of the active folder.
2. Putting folders inside the fullscreen viewer sequence.
3. Reworking the main-process scan pipeline to emit folders as scan events.
4. Redesigning sort behavior for recursive mode.

## Proposed UX

### Non-Recursive Mode
1. Show folders first, then media, in a single grid for the active folder.
2. Folder cards use a distinct visual treatment from media cards but share the same layout system.
3. Single click selects a folder or media item.
4. Double click opens a folder or opens media in the viewer.
5. `Enter` opens the selected item appropriately:
   - folder -> scan/open that folder
   - media -> open viewer
6. `K` remains a folder-open shortcut only if we want to preserve the current one-hand folder workflow; otherwise `Enter` can fully replace that special case.

### Recursive Mode
1. Keep the existing media-only gallery behavior.
2. Hide inline folders from the grid to avoid mixing levels of hierarchy in recursive results.

### Sorting
1. Apply a fixed primary grouping in non-recursive mode:
   - folders first
   - media second
2. Apply the selected sort mode inside each group where practical.
3. If random sort is active, keep folders grouped first and randomize media only unless a later UX decision says otherwise.

## Data Model Refactor

### New Renderer Display Type
Introduce a renderer-only union for grid items, for example:

```ts
type BrowserEntry =
  | { kind: 'folder'; path: string; name: string; hasChildren: boolean }
  | { kind: 'media'; media: MediaItem };
```

This display model should be derived in the renderer rather than pushed into the scan pipeline.

### State Changes
1. Keep `items: MediaItem[]` in app state for scan results and viewer logic.
2. Keep folder children loaded separately from `listFolderChildren(rootPath)`.
3. Build a derived `browserEntries` list in `App.tsx` or a renderer utility.
4. Track selected browser entry independently from `selectedId` if needed.

Recommended direction:
1. Introduce `selectedBrowserEntryKey` in renderer state.
2. Derive media selection from that entry when the selected entry is media.
3. Keep viewer state based on media index only.

## Implementation Plan

### Phase 1 - Introduce mixed browser entries
1. Add a renderer-side `BrowserEntry` type.
2. Create a utility that merges current folder children with direct media results.
3. Define stable keys for selection and rendering:
   - folder: `folder:${path}`
   - media: `media:${item.id}`

### Phase 2 - Refactor selection model
1. Move grid selection from media-only assumptions to mixed-entry assumptions.
2. Preserve existing `selectedId` updates when the selected entry is media.
3. Clear or remap selection safely when folder/media lists change after a rescan or navigation.

### Phase 3 - Update grid rendering
1. Teach `PrismLayout` to render both folder and media cards in the same virtualized grid.
2. Reuse the current folder card styling from the empty-folder fallback where possible.
3. Ensure the hover/video-preview logic only runs for media entries.
4. Ensure folder cards never attempt thumbnail/video metadata behaviors.

### Phase 4 - Update actions and keyboard behavior
1. Single click selects either folders or media.
2. Double click / `Enter` opens the selected entry appropriately.
3. Keep `I/J/L` for parent/previous/next folder navigation.
4. Decide whether `K` remains "open selected folder" or becomes unnecessary once `Enter` handles folders.
5. Keep media viewer navigation unchanged and media-only.

### Phase 5 - Remove obsolete empty-folder special case
1. Replace the current empty-folder-only folder grid fallback with the unified mixed grid.
2. Keep an actual empty state only for directories with no folders and no media.
3. Simplify the branching logic in `PrismLayout` and `App.tsx` after the mixed model is in place.

## Files Likely to Change
1. `src/renderer/App.tsx`
2. `src/renderer/layouts/PrismLayout.tsx`
3. `src/renderer/layouts/LayoutShellProps.ts`
4. `src/renderer/store/useAppStore.ts`
5. `src/renderer/utils/` (new mixed-entry helper)
6. `src/renderer/components/SettingsDrawer.tsx` if hotkey text changes

## Edge Cases to Handle
1. Folder with many folders and no media.
2. Folder with many folders and one or two media files.
3. Folder with only media.
4. Folder with neither media nor folders.
5. Random sort mode in non-recursive view.
6. Selection persistence after moving to parent/next/previous folder.
7. Mixed grid keyboard behavior when the selected entry is a folder.
8. Viewer launch from mixed grid while folders remain visible nearby.

## Manual Verification Checklist
1. Open a non-recursive folder containing both child folders and media; verify both appear together.
2. Single click a folder, then press `Enter`; verify it opens that folder.
3. Single click media, then press `Enter`; verify the viewer opens the correct item.
4. Double click both a folder and a media item; verify the correct action for each.
5. Use `I`, `J`, and `L`; verify folder navigation still respects the original navigation ceiling.
6. Verify recursive mode remains media-only.
7. Verify random, name, and date sorting still behave predictably.
8. Verify viewer previous/next still ignores folders entirely.

## Risks
1. The current virtualized grid assumes every item is media-shaped and may need careful branching for folder cards.
2. Existing selection logic is tightly coupled to `MediaItem.id` and viewer index math.
3. Mixed content could make keyboard behavior feel inconsistent if selection rules are not clearly defined.

## Recommended Delivery Order
1. Implement the mixed display model without changing viewer behavior.
2. Migrate selection and `Enter` behavior.
3. Remove the old empty-folder fallback.
4. Polish sorting, hover, and card visuals.
