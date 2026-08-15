# Plan 051: One global gallery order with pagination-aware navigation

> **Executor instructions**: Implement this as one behaviour change after Plans 048 and 050 land.
> Write the ordering and navigation regression tests before changing either the repository queries or
> the viewer. Do not replace global random ordering with per-page shuffling. Update the index when
> done.
>
> **Drift check (run first)**:
> `git diff --stat bf8b0c8..HEAD -- apps/pane-view/src/features/gallery apps/pane-view/src/features/comics apps/pane-view/src/features/library apps/pane-view/src/server/library packages/media-domain/src`
> Plans 048 and 050 are dependencies, so their expected changes do not count as accidental drift.
> Re-read `useGalleryBrowse`, the browse-state module that replaces `useGalleryPreferences`,
> `GalleryPage`, `MediaViewerModal`, `gallery-listing.ts`, and `repository.ts` before Step 1.

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM-HIGH. The server order, cursor, accumulated client pages, and controlled viewer
  must agree on item identity.
- **Depends on**: 048 and 050
- **Category**: correctness / gallery navigation
- **Planned at**: commit `bf8b0c8`, 2026-08-15
- **Original finding**: focus-view pagination and random comic-order investigation, 2026-08-15

## Why this matters

Pane View has two pagination models and three navigation loops. Regular media uses a server keyset
cursor. Comic mode fetches media by offset, groups the loaded subset on the client, and sorts that
subset again after every page. The detail panel, the keyboard grid, and `MediaViewerModal` each wrap
their loaded array independently.

The combination produces two visible bugs. Forward navigation from the last loaded image wraps to
the first loaded image instead of loading the next page. Random comic browsing moves newly loaded
entries above the user's scroll position because the client discovers their random rank only after
fetching them.

The fix needs one ordering contract. For a fixed browse request and random seed, the server defines
one total order across the complete result set. Page 1 is the first slice of that order. Page 2 is
the next slice. Concatenating every page must equal the unpaginated order exactly. The client never
sorts an accumulated server result.

## Required behaviour

These are product requirements, not implementation suggestions.

1. **Random means one full-result permutation.** For a result set `S` and seed `r`, each eligible
   subject receives one deterministic random key. Sorting every subject by that key produces one
   permutation `P(S, r)`. Pagination slices `P`; it does not create separate random batches. Across
   uniformly generated seeds, every subject has the same chance of occupying each position.
2. **The same request and seed are stable.** Reloading a page, retrying a request, or loading another
   page returns the same order while the seed stays unchanged.
3. **Shuffle changes the full order.** The Shuffle action creates a new seed and resets pagination to
   page 1. The new seed changes the complete permutation, including the first page.
4. **Every gallery mode uses the contract.** It applies to regular folders, recursive folders,
   filtered media, searches, and comics. A regular browse subject is one media item. A comic browse
   subject is one comic identified by its canonical folder path.
5. **No gaps or duplicates cross pages.** A subject appears once in the concatenated result. Loading
   another page cannot move any already rendered subject.
6. **Forward navigation loads before it loops.** At the last loaded subject, a forward step requests
   the next page when `hasMore` is true. It advances to the first appended subject after the request
   succeeds. It wraps only when the server has reported `hasMore: false` and loop navigation is on.
7. **Selection is identity-based.** Loading, deleting, or refreshing a page cannot change the current
   subject merely because its array index changed.

Folder navigation cards are not random browse subjects. Keep folder cards in their current section
and order. Random ordering applies to media and comics.

For 1,000 subjects and a page size of 48, page 1 is `P[0..47]`, page 2 is `P[48..95]`, and so on.
Any subject may occupy any position in `P`. A new seed changes the whole `P`, not only the order
inside each 48-subject slice.

## Current state

All references are to `apps/pane-view/src/` unless another root is named.

- `features/gallery/MediaViewerModal.tsx:38-60` owns a numeric index and uses modulo arithmetic when
  `loopNavigation` is on. It receives no `hasMore` or load function.
- `features/gallery/GalleryPage.tsx:344-354` uses separate modulo arithmetic for detail-panel media
  navigation.
- `features/gallery/useGalleryKeyboard.ts:47-80` wraps grid focus over the loaded `entries` array.
- `features/gallery/useGalleryViewerHandoff.ts:24-41` captures the entire media array when the viewer
  opens. Later pages cannot enter an open viewer.
- `features/gallery/useGalleryBrowse.ts:188-246` owns the actual next-page requests but exports only
  the fire-and-forget `handleLoadMoreMedia` button callback.
- Regular mode uses `getGalleryListing` and a keyset cursor. `repository.ts:396-425` orders random
  media by `md5(seed + ':' + entry.id)`, and `:483-506` continues from that order. This is already
  the right shape for a global seeded permutation.
- Comic mode uses `getLibrarySnapshot` with `mediaOffset`. `repository.ts:96-110` orders the source
  rows by logical path, not the requested gallery order.
- `features/gallery/gallery-page-helpers.ts:188-199` merges every loaded comic-mode media page and
  sorts the whole merged array on the client. `:225-238` then rebuilds and sorts every comic. A
  later page can therefore insert entries before the current scroll position.
- `packages/media-domain/src/sort.ts:40-70` uses a path-based FNV score for client random sorting,
  while the server listing uses an ID-based MD5 score. Pane View has two definitions of random rank.
- `server/library/gallery-listing.ts` models only media listing pages. `getGalleryListing` rejects
  comic mode in `features/library/library-service.ts:136-138`.
- `features/comics/ComicReader.tsx` requires a full `ComicEntry` with every page. Returning every
  page for every comic in a listing page would make the listing payload unbounded.

## Feedback loops

Create these tests before the implementation. They replace the temporary investigation tests.

| Signal | Command | Failure before the fix |
|---|---|---|
| Global random pagination | `pnpm --dir apps/pane-view exec vitest run src/server/library/gallery-order.test.ts` | A concatenated comic result differs from the full fixed-seed order, or a cursor repeats or skips a subject. |
| Accumulated client order | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/useGalleryBrowse.test.tsx` | Loading a comic page inserts a new entry before the existing prefix. |
| Boundary navigation | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/gallery-navigation.test.tsx` | Forward from the loaded end wraps without calling `loadNextPage`. |
| Controlled viewer | `pnpm --dir apps/pane-view exec vitest run src/features/gallery/MediaViewerModal.test.tsx` | The viewer follows an old numeric index or cannot see appended media. |

The first test may use the rendered-SQL seam from Plan 050 plus an in-memory comparator for its
fixture oracle. Do not use live randomness in tests. Use fixed subject IDs and fixed seeds.

## Scope

**In scope**: a shared server ordering contract; a cursor-paginated comic summary listing; lazy
comic-page loading; one cursor pagination path in `useGalleryBrowse`; identity-based viewer state;
pagination-aware detail, grid, and modal navigation; deterministic randomness tests; the gallery
request and response types needed by those changes.

**Out of scope**: changing the persisted page size; randomizing folder cards; changing Frame View's
local archive sort; cryptographic secrecy for the seed; preloading every remaining page to support a
backward wrap from the first item; schema changes; comic-reader page virtualization.

## Decisions taken in this plan

1. **The server owns presentation order.** The client displays server pages in response order and
   appends later pages. Pane View does not call `sortMediaItems` or `sortComicEntries` on accumulated
   server results.
2. **Random rank is deterministic and server-compatible.** Use one helper for
   `hash(seed, subjectKind, subjectId)`. PostgreSQL must produce the same key used by the cursor
   encoder and the fixture oracle. The hash is for ordering, not security.
3. **The seed is part of the browse request and cursor.** Validate that a cursor's seed, sort mode,
   and subject kind match the request. Reject a stale or mismatched cursor instead of continuing
   with two orders.
4. **Comic listing returns summaries.** Add a `GalleryComicSummary` containing the canonical comic
   ID, folder path, display name, cover, and page count. Do not include every page in the listing.
   Load the full `ComicEntry` when the user opens the comic reader.
5. **One hook owns page accumulation and boundary stepping.** Deepen `useGalleryBrowse` rather than
   adding page and cursor rules to `GalleryPage`, `MediaViewerModal`, and `useGalleryKeyboard`.
   Callers ask it to load or step. They do not inspect cursors.
6. **The viewer is controlled by media ID.** Remove the captured `viewerItems` array and the modal's
   independent numeric index. The live browse sequence and selected ID determine the current item.
7. **Backward wrap does not fetch the whole archive.** If the user is at the first loaded item while
   `hasMore` is true, a backward step stays at the first item. After the final page loads, loop
   navigation may wrap to the true final item.
8. **One in-flight next-page request exists per browse session.** The load-more observer, button,
   keyboard, detail panel, and viewer share the same promise. Repeated key presses cannot issue
   duplicate cursor requests.
9. **Shuffle uses a uniformly generated seed.** Generate 16 random bytes with
   `crypto.getRandomValues` and encode them as 32 lowercase hexadecimal characters. If the result
   matches the current seed, generate another. Persist one seed for the browse session, and change it
   only when the user invokes Shuffle.

## Proposed interfaces

Keep the external seam small. Names may adjust after Plan 048 lands, but the behaviour must remain
behind the browse module.

```ts
export interface GalleryPageState {
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

export interface GalleryBrowseSession {
  entries: GalleryBrowseEntry[];
  media: LibraryMediaItem[];
  page: GalleryPageState;
  loadNextPage(): Promise<LoadNextPageResult>;
  stepEntry(currentKey: string, direction: -1 | 1, loop: boolean): Promise<string | null>;
  stepMedia(currentId: string, direction: -1 | 1, loop: boolean): Promise<string | null>;
}

export interface LoadNextPageResult {
  appendedEntryKeys: string[];
  appendedMediaIds: string[];
  exhausted: boolean;
}
```

`stepEntry` and `stepMedia` return stable keys. `GalleryPage` writes the returned media ID through
the browse-state selection intent from Plan 048. The implementation may use refs internally so an
awaited page result does not depend on a stale React render.

The browse module has one internal I/O seam:

```ts
interface GalleryPageSource {
  loadPage(request: GalleryPageRequest): Promise<GalleryPageResponse>;
  loadComic(request: GalleryComicRequest): Promise<ComicEntry>;
}
```

Use a server-function adapter in production and an in-memory adapter in tests. Keep this port inside
the browse implementation. Gallery callers must not receive it or understand transport details.

## Git workflow

- Branch: `agent/051-global-gallery-order`
- Commit message: `Fix Pane View paginated gallery ordering`

## Steps

### Step 1: Pin the ordering contract with fixed fixtures

Add `server/library/gallery-order.ts` with the smallest pure interface needed by both cursor types
and tests:

```ts
export type GallerySubjectKind = "media" | "comic";
export type GalleryRandomSeed = string; // Validated 32-character lowercase hexadecimal value.
export function galleryRandomOrderKey(
  seed: GalleryRandomSeed,
  subjectKind: GallerySubjectKind,
  subjectId: string,
): string;
```

Use a fixed-width hash string so lexical SQL order and TypeScript order agree. Prefix the subject
kind before hashing. A media ID and a comic folder path must not share a rank input by accident.

Add a Pane View seed helper that reads 16 bytes from `crypto.getRandomValues`, returns lowercase hex,
and never returns the current seed during Shuffle. Validate the same exact format in the server
request and cursor schemas. Change Plan 048's numeric `randomSeed` field to `GalleryRandomSeed`, but
do not change the shared Frame View seed helper in this plan.

Add deterministic tests with at least 1,000 fixture subjects and a fixed list of seeds:

- the same seed and subject set produce the same permutation;
- input order does not change the permutation;
- each permutation contains every subject exactly once;
- two different fixture seeds do not produce the same permutation or first page;
- concatenating cursor pages equals the full permutation exactly;
- changing page size changes only the slice boundaries, not the full order;
- regular, recursive, filtered, searched, and comic request fixtures obey the same properties;
- a histogram over the fixed seeds puts subjects in each position quartile. Choose and document a
  deterministic tolerance that catches a broken constant or path-prefix rank without creating a
  flaky test.

The property is global permutation equality. Do not accept a test that merely proves each page looks
shuffled.

**Verify**: the pure random tests pass. The pagination tests fail until Steps 2 and 3 use the shared
key and comic cursor.

### Step 2: Make the media cursor use the shared order

Route regular media random ordering through `galleryRandomOrderKey` and its SQL expression. Keep the
existing total-order tie breakers. Extend the cursor validation from Plan 050 to require the request's
subject kind and random seed.

Add rendered-SQL assertions for the order expression and cursor comparison. Add an in-memory cursor
fixture that collects all pages for each supported page size and compares the concatenated IDs with
the full comparator result.

Preserve all current populations:

- non-recursive folder media;
- recursive subtree media;
- search matches;
- `showImages` and `showVideos` filters;
- each non-random sort mode.

**Verify**: regular media keeps its current append-only behaviour. Fixed-seed requests return no
duplicates or gaps, and a changed seed invalidates the old cursor.

### Step 3: Add a cursor-paginated comic summary listing

Extend the listing repository to accept `subjectKind: "comic"`. Query one row per eligible leaf
folder under the normalized browse scope. A comic qualifies under the same path, query, soft-delete,
and media visibility rules as current comic grouping.

Return `GalleryComicSummary` rows with:

- `id` and `folderPath`, both based on the canonical folder path;
- `name`;
- `cover`;
- `pageCount`;
- no full `pages` array.

Order the complete comic population before applying `limit`. In random mode, rank the canonical
folder path with the request seed. In the other sort modes, preserve the observable comic ordering
unless the server cannot reproduce the current natural-name comparison. See the STOP conditions.

Add a discriminated comic cursor. Its last subject tuple must continue the same server order. The
cursor includes the subject kind, sort mode, and random seed. It must not encode a media offset.

Change `getGalleryListing` to serve both media and comic summary pages. Remove the service-level
comic rejection. Once the client consumes this path, request `mediaLimit: 0` from
`getLibrarySnapshot` in every gallery mode. The snapshot remains the folder and archive-state query.

**Verify**: fixed fixtures with more than three page sizes prove that concatenated comic pages equal
the full comic order. With one seed, a comic can appear on any page according to its global rank.
Loading page 2 never changes page 1.

### Step 4: Load comic pages only when the reader opens

Add a server function and query option that resolve one `GalleryComicSummary.id` into a full
`ComicEntry`. The request carries the active path and query rules needed to preserve the listing's
eligibility semantics. The server authorizes the web session and validates that the comic folder is
inside the requested browse scope.

Update Pane View's gallery entry type so a comic card consumes `GalleryComicSummary`. Replace uses
of `comic.pages.length` in the grid with `pageCount`. Selection and deletion overlays use the cover
ID unless a full comic is loaded.

When the user activates a comic summary, fetch its pages, keep the summary visible while loading,
and open `ComicReader` only after the full `ComicEntry` arrives. Cache the result by comic ID and the
browse filters that affect eligibility.

**Verify**: the listing payload size depends on the number of comic summaries, not the number of
pages inside those comics. Opening a comic with more pages than the gallery page size shows every
eligible page in natural page order.

### Step 5: Collapse client pagination to one cursor path

Change `useGalleryBrowse` so regular media and comic summaries both consume `getGalleryListing`.
Delete comic-mode `mediaOffset` accumulation and the client calls to `sortMediaItems`,
`buildComicEntries`, and `sortComicEntries` from the gallery browse path.

Inject the internal `GalleryPageSource` port. The production adapter calls the TanStack server
functions. Tests use an in-memory adapter with scripted pages and deferred promises. Test observable
session results through the `GalleryBrowseSession` interface instead of mocking imported server
functions or asserting internal reducer state.

Store pages in response order. Append unseen subjects by stable key. Treat a duplicate key or a
cursor that does not advance as an error instead of silently merging it. Keep the current load-more
button and intersection observer, but route both through one promise-returning `loadNextPage`.

When the browse request, sort mode, filters, or random seed changes, clear all accumulated pages and
start from page 1. When only the next cursor changes, preserve the rendered prefix exactly.
Shuffle obtains a new `GalleryRandomSeed`, writes it through the Plan 048 browse state, and resets the
request. Loading more reuses the current seed unchanged.

**Verify**: `useGalleryBrowse.test.tsx` proves that a random comic page appends after the current
prefix. It also proves that Shuffle clears the prefix and that simultaneous button, observer, and
navigation requests share one server call.

### Step 6: Put boundary navigation behind the browse session

Add `stepMedia` and `stepEntry` to the browse interface. Both methods use stable IDs or keys.

For a forward step:

1. Move within the loaded sequence when a next subject exists.
2. At the loaded end, await the shared `loadNextPage` promise when `hasMore` is true.
3. Move to the first appended subject after a successful response.
4. Stay on the current subject when the response fails or appends nothing while still reporting an
   error state.
5. If `hasMore` is false, wrap only when loop navigation is on.

Wire detail-panel buttons and grid keyboard movement through these methods. Preserve spatial W, A,
S, and D movement inside the loaded grid. Only an attempted forward move beyond the final loaded
entry invokes pagination.

**Verify**: hold the forward key at a page boundary. Exactly one request runs. The selection remains
on the boundary subject while loading and advances once to the first appended subject.

### Step 7: Make the media viewer controlled and live

Replace `MediaViewerModal`'s `startIndex` and local index with a controlled media ID and the live
browse media sequence. Remove `viewerItems` from `useGalleryViewerHandoff`; store only whether the
viewer is open and any explicit locked ID that still has a caller after Plan 048.

The modal calls `stepMedia` for arrows and viewer shortcuts. Derive neighbor prefetch, button enabled
state, and the rendered item from stable IDs. While the next page loads, keep the current media
mounted and disable repeated forward transitions without blocking Escape.

Add these regression cases to `MediaViewerModal.test.tsx` or the browse-session test:

- forward at a partial-page boundary loads and advances;
- forward at the true end wraps when loop navigation is on;
- forward at the true end stays when loop navigation is off;
- appended media becomes visible to an already open viewer;
- a rerender that inserts or removes another item does not change the current media ID;
- a failed load keeps the current media and permits retry.

**Verify**: the temporary investigation case now passes. The last loaded item does not wrap while
`hasMore` is true.

### Step 8: Validate every mode end to end

Create a deterministic fixture archive with enough subjects for at least three pages in each mode.
Record the seed and expected full subject order in the test, not in production state.

Run automated coverage for:

- regular non-recursive media;
- regular recursive media;
- image-only and video-only filters;
- search results;
- comic summaries;
- at least three page sizes;
- at least two fixed seeds per mode.

For every case, assert that concatenated pages equal the full fixed-seed order, with no duplicates or
gaps. Assert that page 1 remains a prefix after pages 2 and 3 load.

Run the manual smoke with `pnpm dev:pane` and a folder that has more than two pages:

- [ ] Select Random in a regular folder. Capture the first page IDs. Load two pages. The captured
      IDs stay in the same positions.
- [ ] Repeat with recursive mode and a search query.
- [ ] Repeat in comic mode. New comic cards appear only after the loaded cards.
- [ ] Press Shuffle. The first page and the later pages change as one new global permutation.
- [ ] Open the last loaded media item. Press forward. Pane View loads once and advances to the first
      item from the next page.
- [ ] Keep advancing through the final server page. Only then does loop navigation return to the
      first item.
- [ ] Open a comic whose page count exceeds one gallery page. `ComicReader` shows the complete comic.

## Verification commands

| Purpose | Command | Expected on success |
|---|---|---|
| Ordering and repository | `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` | All order, cursor, and comic-summary tests pass. |
| Gallery and viewer | `pnpm --filter @latch-works/pane-view test -- src/features/gallery src/features/comics` | All pagination and navigation tests pass. |
| Shared domain | `pnpm --filter @latch-works/media-domain test` | Existing Frame and shared ordering behaviour remains unchanged. |
| Pane check | `pnpm --filter @latch-works/pane-view check` | Exit 0. |
| Workspace typecheck | `pnpm typecheck` | Exit 0. |

## Done criteria

- [ ] One documented random-order function defines the server order for media and comics.
- [ ] Shuffle uses `crypto.getRandomValues`, produces a seed different from the active seed, and
      resets every mode to page 1.
- [ ] For every supported gallery mode, concatenating cursor pages equals the complete fixed-seed
      permutation in deterministic tests.
- [ ] No Pane View client module re-sorts accumulated server pages.
- [ ] Comic listing pages contain summaries, and `ComicReader` loads a complete comic on demand.
- [ ] The load-more button, observer, grid, detail panel, and modal share one in-flight page request.
- [ ] Forward navigation loads the next page before considering a loop.
- [ ] `MediaViewerModal` tracks media identity and receives later pages while open.
- [ ] Shuffle changes the seed and resets to page 1. Loading more keeps the seed.
- [ ] Automated tests cover regular, recursive, filtered, searched, and comic random ordering.
- [ ] `pnpm --filter @latch-works/pane-view check` and the manual smoke pass.

## STOP conditions

- The product owner wants folder navigation cards included in the random permutation. This plan
  treats only media and comics as random subjects.
- The server cannot reproduce the current non-random comic name or date order without a schema or
  collation change. Record the mismatch and choose the intended product order before changing it.
- A comic summary query needs to scan or return every media row before applying its page limit.
  Stop and revise the query or add the required index before shipping an unbounded listing.
- Search is meant to list a matching comic but open every page in that comic. Current grouping only
  includes matching pages. That product change needs an explicit decision before Step 4.
- Backward navigation from the first item must wrap to the true last item before all pages load.
  That requires reverse cursors or loading the remaining result set and is outside this plan.

## Maintenance notes

The server response order is authoritative. Reviewers should reject client code that sorts merged
gallery pages or randomizes each page independently. New browse modes must identify their subject
kind, use the shared seeded order, validate cursors against the request, and pass the concatenated-page
equality tests.

Plan 050's repository tests remain the SQL-level guard after this plan changes the listing query.
Plan 048 remains the owner of URL and persisted browse state. This plan owns ordered page
accumulation and movement across page boundaries.

Tests at the `GalleryBrowseSession` interface replace shallow tests of retired merge and client-sort
helpers. Keep repository SQL tests because they verify the production adapter's server query rather
than duplicate the session tests.
