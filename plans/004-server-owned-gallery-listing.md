# Plan 004: Move Gallery Sorting Filtering And Pagination To Server Queries

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report - do not improvise. When done, update the status
> row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c328a78..HEAD -- apps/pane-view/src/features/library apps/pane-view/src/server/library apps/pane-view/src/features/gallery apps/pane-view/src/routes/_gallery/index.tsx packages/media-domain/src`
> If this reports changes, compare the "Current state" excerpts below against the live code before
> proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-dedupe-gallery-derived-state.md`, `plans/003-index-gallery-scope-and-search-queries.md`
- **Category**: perf
- **Planned at**: commit `c328a78`, 2026-06-17

## Why this matters

Pane View currently pages raw media rows from Postgres, then the browser sorts, filters, groups, and
builds visible entries. That means pagination is not aligned with what the user sees: a "first 500
media rows" page is not necessarily the first 500 entries for date sorting, random sorting, hidden
videos, recursive mode, or comic mode. It also inflates snapshot payloads and hydration work by
embedding delivery data for far more media than the virtualized viewport mounts.

After this plan, the client sends the current gallery view state to the server, and the server returns
the next page of already-sorted visible gallery entries, starting around 50-100 entries per page.

## Current state

Relevant files:

- `apps/pane-view/src/features/library/library-service.ts` - server function for library snapshots.
- `apps/pane-view/src/server/library/repository.ts` - current DB snapshot query.
- `apps/pane-view/src/features/library/library-queries.ts` - TanStack Query keys and request shape.
- `apps/pane-view/src/features/gallery/GalleryPage.tsx` - client sorting/filtering/pagination.
- `packages/media-domain/src/browser-entries.ts` - shared `BrowserEntry` shape.
- `packages/media-domain/src/sort.ts` - existing sort modes and deterministic random seed idea.
- `packages/media-domain/src/comics.ts` - current comic grouping.

Current default server media page size:

```ts
// apps/pane-view/src/features/library/library-service.ts:8
export const DEFAULT_MEDIA_PAGE_LIMIT = 500;
const SEARCH_RESULT_LIMIT = 200;
```

Current snapshot request passes path/query/recursive/comic mode, but not sort/filter state:

```ts
// apps/pane-view/src/features/library/library-queries.ts:11
export interface LibrarySnapshotRequest {
  comicMode: boolean;
  path: string | undefined;
  query: string | undefined;
  recursive: boolean;
}
```

Current server media query orders by path regardless of selected sort mode:

```ts
// apps/pane-view/src/server/library/repository.ts:97
.where(and(...mediaConditions))
.orderBy(asc(libraryEntries.logicalPath), asc(libraryEntries.id))
.limit(limit + 1)
.offset(offset),
```

Current client appends pages and then sorts/filters them:

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

Current automatic load more uses an offset:

```tsx
// apps/pane-view/src/features/gallery/GalleryPage.tsx:832
const nextSnapshot = await getLibrarySnapshot({
  data: {
    comicMode: snapshotRequest.comicMode,
    mediaOffset: mediaPage.nextOffset,
    path: snapshotRequest.path,
    query: snapshotRequest.query,
    recursive: snapshotRequest.recursive,
  },
});
```

Documented design constraints:

- `docs/end-to-end-request-flow.md` says gallery data comes from Postgres and bytes are fetched only
  when tiles/viewer need them.
- `docs/runbooks/media-optimizer.md` says ready gallery thumbnail URLs are embedded in snapshots and
  missing visible thumbnails are resolved in bounded batches.
- `CONTEXT.md` says image gallery tiles in production use Image Delivery through Bunny, while the
  Derivative Queue is for video and future PDF derivatives.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Media domain tests | `pnpm --filter @latch-works/media-domain test` | exit 0 |
| Pane library/gallery tests | `pnpm --filter @latch-works/pane-view test -- src/features/library src/server/library src/features/gallery` | exit 0 |
| Typecheck Pane View | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Full Pane View check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**:

- `apps/pane-view/src/features/library/library-service.ts`
- `apps/pane-view/src/features/library/library-queries.ts`
- `apps/pane-view/src/server/library/repository.ts`
- `apps/pane-view/src/server/library/types.ts`
- `apps/pane-view/src/server/library/media-page.ts` or a new cursor helper
- `apps/pane-view/src/features/gallery/GalleryPage.tsx`
- Focused tests under `apps/pane-view/src/features/library/`, `apps/pane-view/src/server/library/`,
  and `apps/pane-view/src/features/gallery/`
- Optional shared type/helper changes under `packages/media-domain/src/`

**Out of scope**:

- Changing CDN token format.
- Changing Derivative Queue or optimizer behavior.
- Replacing the virtual grid.
- Adding new user-facing filters beyond existing image/video visibility.
- PDF cover generation.
- Full text search or source-aware search.

## Git workflow

- Branch: `codex/004-server-owned-gallery-listing`
- Commit message style: short imperative, for example `Move gallery listing to server queries`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Define the server-owned listing contract

Add a new request/response shape rather than overloading `LibrarySnapshot` immediately. Suggested
names:

```ts
export interface GalleryListingRequest {
  comicMode: boolean;
  cursor?: string;
  limit?: number;
  path: string | undefined;
  query: string | undefined;
  randomSeed: number;
  recursive: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

export interface GalleryListingPage {
  entries: BrowserEntry[];
  media: LibraryMediaItem[];
  page: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}
```

Use a default limit between 50 and 100. Start with `60` unless there is a clear local convention.
Keep `LibrarySnapshot` for folder/sidebar/root metadata during this plan.

Cursor must be opaque to the client. A base64url JSON payload is acceptable if it contains no secrets.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0 once types are wired.

### Step 2: Implement server-side media filters and sort order

In `server/library/repository.ts`, add a new listing function such as `readDatabaseGalleryListing`.
It should reuse existing scope/query helpers where possible.

For normal non-comic media mode, implement SQL ordering:

- `name-asc`: `filename ASC`, `logical_path ASC`, `id ASC`
- `name-desc`: `filename DESC`, `logical_path DESC`, `id DESC`
- `date-newest`: `mtime_ms DESC`, `logical_path ASC`, `id ASC`
- `date-oldest`: `mtime_ms ASC`, `logical_path ASC`, `id ASC`
- `random`: deterministic order from `randomSeed` and a stable row key. Do not use `ORDER BY random()`.
  Use a stable expression such as `md5(${seed} || ':' || library_entries.id)` or
  `md5(${seed} || ':' || library_entries.logical_path)`, with `logical_path`/`id` tie-breakers.

Apply existing visibility settings server-side:

- if `showImages` is false, exclude `image` and `gif`;
- if `showVideos` is false, exclude `video`;
- keep PDFs/unknown behavior unchanged unless existing UI already hides them elsewhere.

Use keyset/cursor pagination. Do not use offset for the new listing path.

**Verify**: Add repository-level tests for each sort mode's SQL-facing behavior if the existing test
setup allows it. At minimum run
`pnpm --filter @latch-works/pane-view test -- src/server/library` -> exit 0.

### Step 3: Return delivery data only for the listing page

Move the current media item assembly and embedded thumbnail/preview URL logic into the new listing
function or a shared mapper that both snapshot and listing can use.

Only build `LibraryMediaItem` rows for the returned page. Preserve:

- Bunny Image Delivery tokens for image/gif thumbnails in Bunny mode;
- ready derivative URLs for video thumbnails/previews;
- missing derivative placeholders for visible batch resolver.

Do not embed delivery data for media that is not in the returned page.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/features/library src/server/library` -> exit 0.

### Step 4: Wire a new server function and query hook

In `library-service.ts`, add `getGalleryListing` with Zod validation matching
`GalleryListingRequest`. Validate:

- `limit`: int, min 1, max 200;
- `cursor`: optional string;
- `sortMode`: existing gallery sort modes;
- booleans for `showImages` and `showVideos`.

In `library-queries.ts`, add query keys/options for listing pages. Keep the query key stable and
include all view-state inputs that affect results.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 5: Update `GalleryPage` to consume listing pages

Change `GalleryPage` so media entries come from `useGalleryListingQuery` / `getGalleryListing`
instead of `getLibrarySnapshot` media pages.

Requirements:

- The client sends `{ path, query, recursive, comicMode, sortMode, randomSeed, showImages, showVideos, limit, cursor }`.
- Initial page loads around 60 visible entries.
- The intersection observer requests the next page using `nextCursor`.
- Appended pages must already be in server order; do not re-sort the accumulated media client-side.
- Selection, adjacent navigation, viewer opening, and thumbnail-window resolution still work.
- Keep `LibrarySnapshot` for folders/sidebar/roots if that is the lowest-risk migration path, but avoid
  requesting 500 media rows in the snapshot for the main gallery path.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/features/gallery src/features/library` -> exit 0.

### Step 6: Handle comic mode deliberately

Comic mode cannot be treated as "next 60 images" because visible entries are comic folders. Implement
one of these two approaches:

Preferred:

- Add a server comic listing query that pages comic folders/cover entries.
- Return `BrowserEntry` comic cards with enough page metadata for existing `ComicReader` only if the
  current UI requires it.
- If full page lists are too heavy, STOP and report. Do not silently ship comic cards that cannot open.

Acceptable fallback for this plan:

- Keep current comic mode client grouping behind the old snapshot path.
- Make normal media mode server-owned first.
- Record comic mode as `BLOCKED` or follow-up in `plans/README.md`.

Do not pretend comic mode is solved by paging raw images.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/features/gallery` -> exit 0.

### Step 7: Remove obsolete offset paging from the main gallery path

After the server-owned listing path works, remove or stop using:

- `mediaOffset` load-more calls from `GalleryPage`;
- client-side `sortMediaItems` for the main listing;
- client-side media type filtering for the main listing;
- `DEFAULT_MEDIA_PAGE_LIMIT = 500` for the main gallery listing path.

It is okay to leave old snapshot paging helpers temporarily if management/search tests still depend
on them, but the main gallery route must not use them for visible entries.

**Verify**: `rg -n "mediaOffset|sortMediaItems\\(|DEFAULT_MEDIA_PAGE_LIMIT" apps/pane-view/src/features/gallery apps/pane-view/src/features/library apps/pane-view/src/server/library` -> only intentional compatibility references remain.

## Test plan

- Unit tests for request validation and query key construction.
- Repository tests for sort modes, filters, cursor continuity, and recursive/search scopes.
- Gallery tests for appending next pages without client re-sort.
- Existing media-domain tests must still pass if shared types/helpers change.

## Done criteria

- [ ] Client sends sort mode, random seed, image/video filters, path/query/recursive/comic state,
      limit, and cursor to the server listing function.
- [ ] Normal media mode sorting/filtering/pagination happens in SQL/server code.
- [ ] Initial listing page is around 50-100 visible entries, not 500 raw media rows.
- [ ] Load-more uses an opaque cursor, not offset.
- [ ] Delivery Tokens/URLs are produced only for returned listing entries.
- [ ] Comic mode is either server-owned correctly or explicitly left on the old path with a documented
      status in `plans/README.md`.
- [ ] `pnpm --filter @latch-works/pane-view check` exits 0.
- [ ] `git diff --stat` shows only in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Keyset pagination cannot be implemented without changing public URL/search params.
- Random ordering would require `ORDER BY random()`.
- Comic mode requires loading full page lists for too many folders and would erase the perf win.
- The new listing API would require changing Delivery Token shape.
- The implementation needs a broad redesign of `media-domain` beyond small shared types/helpers.
- Verification fails twice after reasonable fixes.

## Maintenance notes

This is the highest-impact and highest-risk gallery perf plan. Reviewers should compare behavior
across sort modes, recursive mode, search, image/video toggles, random seed stability, selection, and
viewer opening. Once this lands, the old snapshot media payload can likely be shrunk further or split
into a folder/navigation-only snapshot.
