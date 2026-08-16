# Plan 052: One gallery browse session with pagination-aware navigation

> **Executor instructions**: Client-only. Land after Plans 048 and 051. Steps 1–4 each leave the app
> working and may be separate commits on one branch; land them in order. Write the session and
> navigation tests before changing `useGalleryBrowse`, `GalleryPage`, or `MediaViewerModal`. Never
> sort accumulated server pages on the client. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat c8f46f4..HEAD -- apps/pane-view/src/features/gallery apps/pane-view/src/features/comics apps/pane-view/src/features/library apps/pane-view/src/server/library/gallery-listing.ts`
> Plans 048 and 051 are dependencies, so their expected changes do not count as drift. Re-read
> `useGalleryBrowse`, the Plan 048 browse-state module, `GalleryPage`, `MediaViewerModal`,
> `useGalleryViewerHandoff`, `useGalleryKeyboard`, `gallery-page-helpers.ts`, and Plan 051's
> `GalleryListingPage`/`getGalleryComic` types before Step 1.

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM-HIGH. The accumulated client pages, the selected ID, and the controlled viewer
  must agree on item identity, and this touches the hottest client file.
- **Depends on**: 048 (browse state and selection intent), 051 (server order, comic summaries,
  `getGalleryComic`)
- **Category**: correctness / gallery navigation
- **Planned at**: commit `c8f46f4`, 2026-08-16 (split from Plan 051 as first written at `bf8b0c8`)
- **Original finding**: focus-view pagination and random comic-order investigation, 2026-08-15

## Why this matters

Pane View has three independent navigation loops. `MediaViewerModal` owns a numeric index and wraps
with modulo arithmetic; the detail panel does the same in `GalleryPage`; the keyboard grid wraps
over the loaded `entries` array. None of them knows whether more pages exist. Forward navigation
from the last **loaded** image therefore wraps to the first loaded image instead of loading the next
page. The viewer also captures the media array at open time, so pages loaded later never reach it.

Comic mode still fetches by offset and re-sorts the merged result on the client, which is what moves
newly loaded comics above the scroll position in random mode. Plan 051 made the server return
comic summaries in final order with a cursor; this plan makes the client consume that and stop
sorting.

The fix is one browse session that owns page accumulation, boundary stepping, and the population-
change policy, with a controlled viewer that follows a media ID rather than an index.

## Required behaviour

These are product requirements, not implementation suggestions.

1. **The client displays server order.** Pages are appended in response order. No Pane View module
   calls `sortMediaItems`, `sortComicEntries`, or `buildComicEntries` on gallery listing results.
2. **Loading another page never moves a rendered subject.** Page 1 stays a prefix after pages 2..n
   load. New subjects append only.
3. **Forward navigation loads before it loops.** At the last loaded subject, a forward step requests
   the next page when `hasMore` is true, and advances to the first appended subject after the
   request succeeds. It wraps only when the server has reported `hasMore: false` and loop navigation
   is on.
4. **Selection is identity-based.** Loading, deleting, or refreshing a page cannot change the current
   subject merely because its array index changed.
5. **Shuffle resets.** Shuffle obtains a new seed through Plan 051's helper, writes it through Plan
   048's browse state, and the session starts again from page 1. Loading more reuses the seed.
6. **Population changes are tolerated, not fatal.** After a delete or a sync-driven refetch of page 1,
   the session dedupes by stable key (first occurrence wins) and keeps rendered order. A cursor that
   fails to advance is an error; an overlapping page is not.
7. **Comic mode subjects are comics.** In comic mode the session's media sequence is the covers of
   the loaded comic summaries, in listing order. Detail-panel Open on a comic opens the comic reader,
   not the media viewer. Detail-panel Delete is hidden when the selected entry is a comic summary.
   (Today it deletes the cover file alone, which removes one page from a comic; that behaviour is
   dropped, not preserved.)

Folder navigation cards keep their current section, order, and keyboard behaviour.

## Current state

All references are to `apps/pane-view/src/`.

- `features/gallery/MediaViewerModal.tsx:38-60` owns a numeric index and uses modulo arithmetic when
  `loopNavigation` is on. It receives `items` and `startIndex`, no `hasMore` or load function.
- `features/gallery/GalleryPage.tsx:344-354` (`selectAdjacentMedia`) uses separate modulo arithmetic
  over `navigableMedia` for detail-panel navigation. `:200-210` derives `navigableMedia`,
  `selected`, and `selectedIndex`. `:291` and `:682` call `openViewer(visibleMedia | navigableMedia,
  id)`; `:730` renders `viewerItems ?? visibleMedia`.
- `features/gallery/useGalleryKeyboard.ts:47-80` wraps grid focus over the loaded `entries` array
  when the next index falls outside it.
- `features/gallery/useGalleryViewerHandoff.ts:24-41` captures the entire media array when the viewer
  opens. `lockSelectionToMediaId` has no caller anywhere in `features/` or `routes/`.
- `features/gallery/useGalleryBrowse.ts:188-246` owns the actual next-page requests but exports only
  the fire-and-forget `handleLoadMoreMedia`. `:99-108` resets accumulation when `browseKey`
  changes; `:194-217` appends listing pages without key dedupe for `entries` (`mergeLibraryMedia`
  dedupes `media` only).
- `features/library/library-queries.ts:135-140` (`useDeleteLibraryEntryMutation`) invalidates
  `galleryListingKeys.all` on delete, so page 1 refetches while accumulated pages 2..n stay. The
  refetched page 1's tail overlaps the old head of page 2.
- `features/gallery/gallery-page-helpers.ts:178-199` (`resolveBrowseMedia`) merges every loaded
  comic-mode media page and sorts the whole merged array; `:205-238` (`resolveBrowseEntries`)
  rebuilds and sorts every comic. This is the client sort this plan removes.
- `features/gallery/GalleryPage.tsx:72,288-289,806-810`: `activeComic: ComicEntry | null`; Enter on a
  comic card sets it; `ComicReader` receives the full entry.
- `features/gallery/BrowserEntryCard.tsx:149-181`: the comic card reads `comic.pages.length`,
  `comic.pages.some/every` for overlays, and `comic.cover`.
- `features/comics/ComicReader.tsx` requires a full `ComicEntry` with every page.
- Plan 051 provides `GalleryListingPage { subjectKind, entries, media, comics, page }`,
  `GalleryComicSummary`, `getGalleryComic`, and `createGalleryRandomSeed`.

## Feedback loops

Create these tests before the implementation.

| Signal | Command | Failure before the fix |
|---|---|---|
| Session accumulation | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/useGalleryBrowse.test.tsx` | A comic page is re-sorted; a page-1 refetch overlapping page 2 duplicates or errors; concurrent load requests issue two server calls. |
| Boundary navigation | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/gallery-navigation.test.tsx` | Forward from the loaded end wraps without calling `loadNextPage`. |
| Controlled viewer | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/MediaViewerModal.test.tsx` | The viewer follows an old numeric index or cannot see appended media. |
| Comic summaries | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/comic-summary.test.tsx` | The card needs `pages`; the reader opens before the full comic loads. |

Tests observe the session through its interface with an in-memory `GalleryPageSource`. Do not mock
imported server functions or assert on reducer internals.

## Scope

**In scope**: one cursor pagination path in `useGalleryBrowse` for media and comic summaries; the
`GalleryPageSource` port with production and in-memory adapters; the population-change policy;
identity-based viewer state; pagination-aware detail, grid, and modal navigation; comic cards on
summaries and lazy comic loading; `mediaLimit: 0` for the snapshot in every mode; deletion of the
retired client sort helpers.

**Out of scope**: any server change (Plan 051); changing the persisted page size; preloading every
remaining page to support a backward wrap from the first item; comic-reader page virtualization;
comic (folder) deletion.

## Decisions taken in this plan

1. **The server owns presentation order.** The client appends pages in response order and never
   sorts accumulated results.
2. **One hook owns page accumulation and boundary stepping.** Deepen `useGalleryBrowse` into a
   `GalleryBrowseSession` rather than adding page and cursor rules to `GalleryPage`,
   `MediaViewerModal`, and `useGalleryKeyboard`. Callers ask it to load or step; they never inspect
   cursors.
3. **One I/O port, and TanStack Query is the cache for page 1.** `GalleryPageSource` is the only I/O
   the session performs. Page 1 is `useQuery({ queryKey, queryFn: () => source.loadPage(first) })`
   so invalidation and placeholder behaviour keep working; pages 2..n call `source.loadPage`
   imperatively. Tests inject an in-memory adapter and a `QueryClientProvider`; production injects
   the server-function adapter. Gallery callers never see the port.
4. **Population changes: dedupe, do not error.** When page 1 refetches (delete invalidation, focus
   refetch, sync), rebuild the sequence as new page 1 followed by accumulated pages 2..n with any key
   already present removed. Rendered order is preserved because page 1 under the same seed is a
   prefix of the same permutation. Keep the last accumulated cursor for the next load. The only
   error is a page whose cursor equals the cursor that requested it. Keep the delete mutation's
   listing invalidation; also filter deleted IDs locally as today so removal is immediate.
5. **Exhaustion is not an error.** A next-page response that appends nothing and reports
   `hasMore: false` (deletions since the last page) sets `hasMore: false` and lets the loop rule
   apply. A rejected request leaves `hasMore` unchanged, reports an error state, and permits retry.
6. **The viewer is controlled by media ID.** Remove `viewerItems`, `startIndex`, and the modal's
   local index. The live session media sequence and the selected ID from Plan 048 determine the
   current item. Delete `lockSelectionToMediaId`; it has no caller.
7. **Backward wrap does not fetch the whole archive.** At the first loaded item with `hasMore` true,
   a backward step stays put and `canStepBackward` is false even with loop navigation on. After the
   final page loads, loop navigation wraps to the true final item. Today loop mode wraps to the last
   *loaded* item; that behaviour goes.
8. **One in-flight next-page request per browse session.** The load-more observer, button, keyboard,
   detail panel, and viewer share the same promise held in a ref. Repeated key presses cannot issue
   duplicate cursor requests.
9. **Comic cards consume summaries; the reader loads on demand.** `useQuery` on
   `["gallery-comic", comicId, path, query, showImages, showVideos]` calling `getGalleryComic`. Keep
   the summary card visible while loading; open `ComicReader` only after the full entry arrives.
   Selection and deletion overlays use the cover ID; the "whole comic deleted" overlay is not
   representable from a summary and is dropped.
10. **Comic-mode media sequence = covers.** `session.media` in comic mode is the covers in listing
    order, taken from `GalleryListingPage.media`. `stepMedia` in comic mode moves between comics.
    Detail-panel Open opens the reader for the selected comic; Delete is hidden.

## Proposed interfaces

Names may adjust after Plan 048 lands; the behaviour must stay behind the browse module.

```ts
export interface GalleryPageState {
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  error: unknown | null;
}

export interface GalleryBrowseSession {
  entries: GalleryBrowseEntry[];          // folder | media | comic-summary entries in display order
  media: LibraryMediaItem[];              // media mode: media; comic mode: covers
  page: GalleryPageState;
  loadNextPage(): Promise<LoadNextPageResult>;
  stepEntry(currentKey: string, direction: -1 | 1, loop: boolean): Promise<string | null>;
  stepMedia(currentId: string, direction: -1 | 1, loop: boolean): Promise<string | null>;
  openComic(comicId: string): Promise<ComicEntry<LibraryMediaItem>>;
}

export interface LoadNextPageResult {
  appendedEntryKeys: string[];
  appendedMediaIds: string[];
  exhausted: boolean;
}

// Internal to the browse module.
interface GalleryPageSource {
  loadPage(request: GalleryListingQueryRequest): Promise<GalleryListingPage>;
  loadComic(request: GalleryComicRequest): Promise<ComicEntry<LibraryMediaItem>>;
}

export type GalleryBrowseEntry =
  | { key: `folder:${string}`; kind: "folder"; … }
  | { key: `media:${string}`; kind: "media"; media: LibraryMediaItem }
  | { key: `comic:${string}`; kind: "comic"; comic: GalleryComicSummary };
```

`stepEntry` and `stepMedia` return stable keys; `GalleryPage` writes the returned media ID through
Plan 048's selection intent. The implementation uses refs so an awaited page result does not depend
on a stale render.

`GalleryBrowseEntry` is Pane View's own type. `media-domain`'s `BrowserEntry` (`kind: "comic"` with a
full `ComicEntry`) stays for Frame View; Pane View stops using it for the grid.

## Git workflow

- Branch: `agent/052-gallery-browse-session`
- Commit message: `Fix Pane View paginated gallery navigation`

## Steps

### Step 1: One cursor path with a port and the population-change policy

Introduce `GalleryPageSource`, the production adapter (server functions), and the in-memory adapter
(scripted pages, deferred promises, per-call counters) under `features/gallery/`. Rewrite
`useGalleryBrowse` so regular media and comic summaries both consume `getGalleryListing` through
the port. Delete comic-mode `mediaOffset` accumulation, `toLibrarySnapshotNextPageRequest`, and the
`sortMediaItems`/`buildComicEntries`/`sortComicEntries` calls in `resolveBrowseMedia` and
`resolveBrowseEntries`; delete those helpers if nothing else uses them. Request `mediaLimit: 0` from
`getLibrarySnapshot` in every mode; the snapshot remains the folder and archive-state query.

Store pages in response order keyed by stable key. Implement Decision 4 (dedupe on page-1 refetch)
and Decision 5 (exhaustion vs error). Route the load-more button and the intersection observer
through one promise-returning `loadNextPage` held in a ref (Decision 8). Reset all accumulated pages
when the browse request, sort mode, filters, or seed changes; preserve the rendered prefix exactly
when only the cursor advances.

`useGalleryBrowse.test.tsx` (in-memory adapter, `QueryClientProvider`):

- a random comic page 2 appends after the page 1 prefix and page 1 is unchanged;
- a page-1 refetch whose tail overlaps page 2's head yields no duplicate keys and no reorder;
- a page whose cursor equals the requesting cursor is reported as an error;
- an empty final page sets `hasMore: false` without an error;
- Shuffle clears the prefix and requests page 1 with the new seed;
- button, observer, and two `loadNextPage` calls during one in-flight request produce one adapter
  call.

**Verify**: comic cards still render (temporarily built from summaries in the next step; for this
step the comic entry may carry the summary with `pageCount` displayed). Regular mode behaves as
before.

### Step 2: Comic cards on summaries and lazy comic loading

Change the comic card to `GalleryComicSummary`: `pageCount` replaces `pages.length`; overlays use the
cover ID. Add `openComic` (Decision 9) and change `GalleryPage`'s `activeComic` flow: activating a
comic entry calls `openComic`, keeps the card visible with a loading affordance, and renders
`ComicReader` when the entry arrives. Cache with the query key in Decision 9. In comic mode, detail
Open opens the reader; Delete is hidden (Decision 10).

`comic-summary.test.tsx`: the card renders from a summary alone; Enter on a comic calls the port's
`loadComic` once, opens the reader with every page in the returned order, and a second activation
hits the cache.

**Verify**: opening a comic with more pages than the gallery page size shows every eligible page.
Listing payload size does not depend on pages per comic.

### Step 3: Boundary navigation behind the session

Add `stepMedia` and `stepEntry` (Decision 2). Forward step:

1. Move within the loaded sequence when a next subject exists.
2. At the loaded end, await the shared `loadNextPage` promise when `hasMore` is true.
3. Move to the first appended subject after a successful response.
4. Stay on the current subject when the response fails; report the error state.
5. If `hasMore` is false (including after an exhausted response), wrap only when `loop` is true.

Backward step follows Decision 7. Wire detail-panel buttons and grid keyboard movement through these
methods; preserve spatial W/A/S/D movement inside the loaded grid, and only an attempted move beyond
the final loaded entry invokes pagination. Delete `selectAdjacentMedia`'s modulo arithmetic and the
keyboard wrap at `useGalleryKeyboard.ts:64-71`.

`gallery-navigation.test.tsx`: forward at the loaded end with `hasMore` true calls the port once and
lands on the first appended key; holding forward during the load issues no second call and stays on
the boundary; forward at the true end wraps only with `loop`; backward at the first item with
`hasMore` true stays; a failed load stays and a retry succeeds.

**Verify**: hold the forward key at a page boundary. Exactly one request runs. Selection remains on
the boundary subject while loading and advances once.

### Step 4: Controlled, live media viewer

Replace `MediaViewerModal`'s `items`/`startIndex`/local index with `mediaId` plus the live session
sequence and `stepMedia`. Remove `viewerItems` and `lockSelectionToMediaId` from
`useGalleryViewerHandoff`; it stores only whether the viewer is open. Derive neighbour prefetch,
`canStepForward`/`canStepBackward`, and the rendered item from IDs. While the next page loads, keep
the current media mounted and disable repeated forward transitions without blocking Escape.

`MediaViewerModal.test.tsx` regression cases:

- forward at a partial-page boundary loads and advances;
- forward at the true end wraps when loop navigation is on and stays when it is off;
- appended media becomes visible to an already-open viewer;
- a rerender that inserts or removes another item does not change the current media ID;
- a failed load keeps the current media and permits retry;
- Escape works during a load.

**Verify**: the temporary investigation case passes. The last loaded item does not wrap while
`hasMore` is true.

### Step 5: End-to-end and manual smoke

Automated: with the in-memory adapter scripted from Plan 051's fixture order (record the expected
full order in the test), for regular non-recursive, recursive, image-only, video-only, search, and
comic sessions at page sizes `{7, 48}` and two seeds: the session's concatenated keys equal the
scripted order; page 1 remains a prefix after pages 2 and 3; a page-1 refetch mid-session changes
nothing visible.

Manual, with `pnpm dev:pane` and a folder of more than two pages:

- [ ] Select Random in a regular folder. Capture the first page IDs. Load two pages. The captured
      IDs stay in the same positions.
- [ ] Repeat with recursive mode and a search query.
- [ ] Repeat in comic mode. New comic cards appear only after the loaded cards.
- [ ] Press Shuffle. The first page and the later pages change as one new global permutation.
- [ ] Open the last loaded media item. Press forward. Pane View loads once and advances to the first
      item from the next page.
- [ ] Keep advancing through the final server page. Only then does loop navigation return to the
      first item.
- [ ] Delete an item on page 1 with three pages loaded. Nothing duplicates or reorders.
- [ ] Open a comic whose page count exceeds one gallery page. `ComicReader` shows the complete comic.
- [ ] In comic mode, detail-panel Open opens the reader; Delete is not offered.

## Verification commands

| Purpose | Command | Expected on success |
|---|---|---|
| Gallery and viewer | `pnpm --filter @latch-works/pane-view test -- src/features/gallery src/features/comics src/features/library` | All session, navigation, viewer, and comic-summary tests pass. |
| Shared domain | `pnpm --filter @latch-works/media-domain test` | Unchanged. |
| Pane check | `pnpm --filter @latch-works/pane-view check` | Exit 0. |
| Workspace typecheck | `pnpm typecheck` | Exit 0. |

## Done criteria

- [ ] No Pane View client module sorts accumulated server pages; the retired helpers are gone.
- [ ] Regular media and comic summaries both flow through one cursor path and one port.
- [ ] A page-1 refetch overlapping accumulated pages dedupes without reordering; a non-advancing
      cursor is the only error.
- [ ] The load-more button, observer, grid, detail panel, and modal share one in-flight page request.
- [ ] Forward navigation loads the next page before considering a loop; backward at the first item
      stays while `hasMore` is true.
- [ ] `MediaViewerModal` tracks media identity and receives later pages while open;
      `lockSelectionToMediaId` and `viewerItems` are deleted.
- [ ] Comic cards render from summaries; `ComicReader` loads a complete comic on demand.
- [ ] Shuffle changes the seed and resets to page 1; loading more keeps the seed.
- [ ] Automated tests cover regular, recursive, filtered, searched, and comic sessions.
- [ ] `pnpm --filter @latch-works/pane-view check` and the manual smoke pass.

## STOP conditions

- The product owner wants folder cards included in the random permutation.
- The product owner wants comic deletion from the gallery. That is folder deletion, not cover
  deletion, and needs its own plan.
- Backward navigation from the first item must wrap to the true last item before all pages load.
  That requires reverse cursors or loading the remaining result set and is outside this plan.
- Plan 051's `GalleryListingPage` shape differs from what this plan assumes in a way that changes
  the session interface. Reconcile the types before Step 1 rather than adapting mid-plan.

## Maintenance notes

The server response order is authoritative. Reviewers should reject client code that sorts merged
gallery pages, randomizes each page independently, or treats an overlapping refetched page as an
error. New navigation surfaces call `stepMedia`/`stepEntry`; they never index into the media array
and never wrap on their own.

Plan 048 owns URL and persisted browse state; Plan 051 owns the server order and cursors; this plan
owns ordered page accumulation, the population-change policy, and movement across page boundaries.
Tests at the `GalleryBrowseSession` interface replace shallow tests of the retired merge and
client-sort helpers.
