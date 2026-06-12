# Plan 008: Add Explicit Paging To Gallery Snapshots

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/server/library/repository.ts apps/pane-view/src/features/library/library-service.ts apps/pane-view/src/features/gallery/GalleryPage.tsx apps/pane-view/src/features/library/*.test.ts apps/pane-view/src/server/library/*.test.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Pane View markets itself as a large private media archive, but the library
snapshot silently limits non-search media rows to 5000 with no `hasMore` signal.
Folders larger than that appear incomplete, and client-side sorting then operates
on an arbitrary subset. This plan makes truncation explicit and adds a real
pagination path so large folders can be browsed without pretending the first
5000 rows are the whole archive.

## Current state

- `apps/pane-view/src/server/library/repository.ts` reads folders and media rows.
- `apps/pane-view/src/features/library/library-service.ts` exposes the
  `getLibrarySnapshot` server function.
- `apps/pane-view/src/features/gallery/GalleryPage.tsx` consumes a snapshot and
  sorts `snapshot.media` in the client.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/server/library/repository.ts:77-94
db
  .select({
    entry: libraryEntries,
    object: mediaObjects,
    thumbnail: thumbnails,
  })
  .from(libraryEntries)
  .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
  .leftJoin(thumbnails, and(...))
  .where(and(...mediaConditions))
  .limit(limit ?? 5000)
  .offset(offset),
```

```ts
// apps/pane-view/src/features/library/library-service.ts:15-21
const libraryRequestSchema = z.object({
  comicMode: z.boolean().optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  recursive: z.boolean().optional(),
  searchOffset: z.number().int().min(0).optional(),
});
```

```ts
// apps/pane-view/src/features/library/library-service.ts:62-67
const databaseSnapshot = await readDatabaseLibrarySnapshot({
  currentPath,
  includeAllFolders: comicMode,
  limit: query ? SEARCH_RESULT_LIMIT : undefined,
  offset: query ? searchOffset : 0,
  query,
  recursive,
});
```

Repo conventions to match:

- TanStack Start server functions use Zod input validators.
- Gallery UI is a real app surface, not a marketing page. Keep controls dense
  and work-focused.
- Existing virtualized grid should remain the main large-list rendering tool.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Library tests | `pnpm --filter @latch-works/pane-view test -- src/features/library src/server/library` | exit 0, focused tests pass |
| Gallery tests | `pnpm --filter @latch-works/pane-view test -- src/features/gallery` | exit 0, if gallery tests exist |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |

## Scope

**In scope**:

- `apps/pane-view/src/server/library/repository.ts`
- `apps/pane-view/src/features/library/library-service.ts`
- `apps/pane-view/src/features/gallery/GalleryPage.tsx`
- Focused tests for library snapshots and paging
- `plans/README.md`, status row only

**Out of scope**:

- Replacing the gallery grid.
- Adding full server-side sorting for every sort mode unless required by a STOP
  condition decision.
- Changing sync/indexing schema.
- Changing media delivery URLs.

## Git workflow

- Branch: `codex/008-page-gallery-snapshots`
- Commit style: short imperative summary, for example
  `Page Pane View gallery snapshots.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Add explicit page metadata to snapshots

Extend the library snapshot shape with media paging metadata. Suggested shape:

```ts
interface LibrarySnapshot {
  ...
  media: LibraryMediaItem[];
  mediaPage: {
    hasMore: boolean;
    limit: number;
    nextOffset: number | null;
    offset: number;
  };
}
```

Extend `libraryRequestSchema` with non-search media pagination fields such as
`mediaOffset` and `mediaLimit`. Keep `searchOffset` working for existing search
behavior, or intentionally replace it with a unified `offset` only if all call
sites are updated.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Make repository queries deterministic and overfetch by one

In `readDatabaseLibrarySnapshot`, fetch `limit + 1` rows and return only `limit`
rows to the caller. Use the extra row to set `hasMore`.

Add a stable `orderBy` before applying `limit` and `offset`. If existing domain
helpers define path/name ordering, use them. Otherwise use a deterministic
database order such as `libraryEntries.logicalPath` plus a stable tie-breaker.

Do not keep the silent `limit ?? 5000` behavior without surfacing metadata. If a
default page size is needed, define it as a named constant in the service layer.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add a load-more UI path

Update `GalleryPage.tsx` so a snapshot with `mediaPage.hasMore` lets the user
load the next page. Keep the UI practical:

- A compact "Load more" control at the end of the virtualized grid is acceptable.
- Reset accumulated media when path, query, recursive mode, or comic mode changes.
- Avoid duplicating media rows when pages are appended.
- Preserve existing sort controls. Sort the accumulated rows, not only the latest
  page.

If this reveals that date/random sorting must be globally correct before all
pages are loaded, stop and report. That may require a separate server-side sorting
plan rather than a quick client patch.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 4: Add focused tests

Add tests for:

- Repository returns `hasMore: true` when overfetch finds an extra media row.
- Repository returns deterministic pages with no duplicated rows across offsets.
- Service passes the correct offset/limit for search and non-search requests.
- UI or hook logic resets accumulated pages when the request key changes, if a
  test harness exists.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/features/library src/server/library`
-> exit 0.

## Test plan

- Prefer service/repository unit tests over brittle DOM tests.
- Add a small UI-state test only if the project already has React test tooling.
- Use fake rows/mocks; do not require PostgreSQL for these tests unless an
  existing repository integration pattern exists.

## Done criteria

- [ ] Library snapshots include explicit paging metadata.
- [ ] Non-search gallery requests no longer silently truncate at 5000 rows.
- [ ] Media queries have stable order before offset/limit.
- [ ] Gallery has a user-visible path to request more media when `hasMore` is
      true.
- [ ] Focused library tests and Pane View typecheck pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Correct sorting requires a broader server-side sort/pagination redesign.
- Comic mode grouping cannot be made correct with paged media without changing
  its product behavior.
- Repository tests require a real database and no test database is available.
- API shape changes would break external clients beyond the Pane View app.

## Maintenance notes

Future sort/filter work should treat paging as part of the API contract. A
reviewer should especially check reset behavior between paths and searches; stale
accumulated rows are the most likely UI regression.
