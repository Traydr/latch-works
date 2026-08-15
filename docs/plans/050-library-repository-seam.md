# Plan 050: Test the library repository at its real seam and collapse its duplicated internals

> **Executor instructions**: Server-only, no schema or route changes. Pin behaviour with tests before
> touching the query builders; the SQL must render identically after each dedupe step. Update the
> index when done.
>
> **Drift check (run first)**: `git diff --stat 7076ce8..HEAD -- apps/pane-view/src/server/library apps/pane-view/src/features/library/types.ts apps/pane-view/src/features/library/library-service.ts`
> If `repository.ts` or `gallery-listing.ts` changed materially, re-read before Step 1.

## Status

- **Status**: TODO
- **Priority**: P3
- **Effort**: M
- **Risk**: LOW–MEDIUM — the risky part (keyset cursor) is pinned by tests before it is touched
- **Depends on**: — (independent of 048/049; can run in parallel)
- **Category**: architecture / test coverage
- **Planned at**: commit `7076ce8`, 2026-08-14
- **Original finding**: Pane View architecture review 2026-08-14, candidate 5

## Why this matters

`server/library/repository.ts` (548 lines) is the only place Pane View turns a browse request into
SQL, and it has no direct test. `repository.test.ts` exists but imports only the two small modules
that were extracted *for* testability — `media-page.ts` (26 lines) and `query-helpers.ts` (33
lines). The 97-line keyset-cursor builder, where a wrong comparison silently returns a
wrong-but-valid page, is untested; so is the 35-line search/scope condition block, which is
duplicated verbatim in both read paths, and the row→`LibraryMediaItem` mapper, which exists twice.

At the seam, `decodeGalleryListingCursor` accepts a cursor whose `sortMode` differs from the request's
and, for `random`, tolerates a missing seed/hash (`cursor.randomSeed ?? 0`). Either mismatch orders
by one rule and filters by another. Nothing rejects it.

The fix is not to extract more pure fragments. It is to test the repository through its own
interface using the rendered-SQL pattern this repo already uses, then collapse the duplication behind
that pinned behaviour.

## Current state

All references are to `apps/pane-view/src/`.

- `server/library/repository.test.ts:1-3` imports `buildMediaPage` (`media-page.ts`) and
  `escapeLikePattern`/`resolveMediaScope` (`query-helpers.ts`) — nothing from `repository.ts`.
- Duplicated condition block: `repository.ts:57-91` (`readDatabaseLibrarySnapshot`) and `:214-250`
  (`readDatabaseGalleryListing`) — same trimmed-query, `ilike` on `logicalPath`/`filename`,
  `folders.path`/`name`, `parentPath` vs subtree prefix.
- Duplicated row mapper: `repository.ts:151-167` inline vs `:530-548` `mapMediaRowsToLibraryItems`.
- Cursor: `buildGalleryListingOrderBy` `:396-425` and `buildGalleryListingCursorCondition` `:427-523`.
  Order/compare pairs were checked on 2026-08-14 and are consistent for all five modes. Random mode
  embeds `md5(concat(seed, ':', id))` three times per branch and defaults `cursor.randomSeed ?? 0`,
  `cursor.randomHash ?? ""`.
- `gallery-listing.ts:36-63` `decodeGalleryListingCursor` validates `id`, `logicalPath`, `filename`,
  `mtimeMs`, and that `sortMode` is a string — not that it is a valid `GallerySortMode`, not that
  `randomSeed`/`randomHash` are present when `sortMode === "random"`. `readDatabaseGalleryListing`
  never compares `decodedCursor.sortMode` to its own `sortMode`, nor `decodedCursor.randomSeed` to
  `randomSeed`.
- Twin types: `server/library/types.ts` and `features/library/types.ts` both declare
  `interface LibraryMediaItem extends MediaItem {}` and a `MediaPage`; `server/library/media-page.ts:1`
  declares a third `MediaPage`. Structurally identical; TypeScript never complains.
- Dead export: `repository.ts:182` `folderFromPath` has no callers.
- Callers of the repository: `features/library/library-service.ts:75,103,139` (dynamic imports).
- No test database exists in this repo; every server test mocks `../db`. House pattern for asserting
  SQL: `server/auth/login-throttle-sql.test.ts` — construct a drizzle executor with a stub client and
  assert `.toSQL()`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Library tests | `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |
| Manual smoke | `pnpm dev:pane` → gallery in each sort mode, scroll to load more | see Step 5 |

## Scope

**In scope**: `server/library/repository.ts`, `gallery-listing.ts`, `repository.test.ts` (rewritten
to test the repository), `media-page.ts`, `query-helpers.ts`, the three type files;
`library-service.ts` only if the cursor-mismatch rejection needs an error mapping.

**Out of scope**: introducing a test database (pglite/testcontainers) — see Decisions; changing the
cursor wire format; changing sort semantics or page sizes; the client-side `useGalleryBrowse`.

## Decisions taken in this plan

1. **Rendered-SQL tests, not a test database.** It matches the existing house pattern, needs no
   infrastructure, and pins exactly the thing that is untested (the SQL the builders emit). A pglite
   adapter would be a genuine second adapter for `db` and would also unlock worker tests for Plan
   049; propose it separately if the rendered-SQL tests prove too brittle.
2. **Cursor mismatch is rejected, not tolerated.** A cursor whose `sortMode` or `randomSeed` differs
   from the request is treated as invalid (`decode` returns `null` → first page). This is a
   behaviour change only for clients sending stale cursors across a sort change, which
   `useGalleryBrowse` never does (its `browseKey` includes both fields).
3. **Query-building is split from executing** inside `repository.ts` so tests can render without a
   connection: `buildLibrarySnapshotQueries(request)` / `buildGalleryListingQuery(request)` return
   drizzle query objects; the exported `readDatabase*` functions execute them. These builders are
   *internal seams* — exported for the test file, not part of the repository's interface to
   `library-service.ts`.

## Git workflow

- Branch: `agent/050-library-repository-seam`
- Commit message: `Test Pane View library repository at its seam`

## Steps

### Step 1: Pin current SQL before changing anything

Add a stub executor to `repository.test.ts` in the `login-throttle-sql.test.ts` style. Split
`readDatabaseGalleryListing` minimally so the media `select` (the one with `.orderBy(...).limit(...)`)
is built by an exported `buildGalleryListingMediaQuery({ conditions, sortMode, randomSeed, limit })`
and the cursor condition by the existing (now exported) `buildGalleryListingCursorCondition`. Do
**not** change any SQL yet.

Write tests that render and snapshot-assert:

- the `ORDER BY` for all five sort modes (`name-asc` default, `name-desc`, `date-newest`,
  `date-oldest`, `random` with a fixed seed);
- the cursor `WHERE` for all five modes with a fixed cursor payload;
- for each mode, that the tuple order in `ORDER BY` and the comparison directions in the cursor
  agree (assert programmatically: `desc` column ⇒ `<` in the leading disjunct, `asc` ⇒ `>`).

**Verify**: tests pass against the unchanged builders; the pinned SQL strings are committed.

### Step 2: Tighten the cursor seam

In `gallery-listing.ts` `decodeGalleryListingCursor`:

- validate `sortMode` against the `GallerySortMode` union (reuse the guard from
  `useGalleryState.ts:66-74`, or add `isGallerySortMode` to `@latch-works/media-domain` if it is not
  already there — check first);
- when `sortMode === "random"`, require `typeof randomSeed === "number"` and
  `typeof randomHash === "string"`;
- accept an optional second argument `expected: { sortMode; randomSeed? }` and return `null` on
  mismatch. `readDatabaseGalleryListing` passes its own `sortMode`/`randomSeed`.

Remove the `?? 0` / `?? ""` fallbacks in `buildGalleryListingCursorCondition` — the types are now
non-optional in the random branch. Hoist the `md5(concat(...))` fragment into one `randomOrderKey(seed)`
helper used by both `buildGalleryListingOrderBy` and the cursor condition.

**Verify**: `gallery-listing.test.ts` gains: invalid `sortMode` → `null`; random without seed/hash →
`null`; sort mismatch → `null`; seed mismatch → `null`; matching → payload. Step 1's rendered SQL is
unchanged for the valid cases.

### Step 3: Collapse the duplicated internals

Behind the pinned tests:

- Extract `buildLibraryConditions({ currentPath, query, recursive })` returning
  `{ mediaConditions: SQL[]; folderConditions: SQL[] }` — the block at `:57-91` / `:214-250` — and
  call it from both read paths. Add the `showImages`/`showVideos` and cursor conditions after, in
  the listing path only.
- Delete the inline mapper at `:151-167`; use `mapMediaRowsToLibraryItems`.
- Delete `folderFromPath` (`:182-190`) — no callers.
- Delete `features/library/types.ts` `LibraryMediaItem`/`MediaPage` and `media-page.ts`'s local
  `MediaPage`; keep one declaration in `server/library/types.ts` and re-export it where the client
  imports it. If `LibraryMediaItem` adds nothing over `MediaItem`, replace it with a type alias and
  say so in the PR.

**Verify**: Step 1 and Step 2 tests pass unchanged; `git diff --stat` shows `repository.ts` shrinks
by ~80 lines; `pnpm typecheck` passes.

### Step 4: Test the two read paths at their interface

Extend `repository.test.ts` to render both `readDatabaseLibrarySnapshot`'s media query and
`readDatabaseGalleryListing`'s media query for these request shapes and assert on the rendered SQL:

- root, non-recursive (`parent_path = ''`);
- folder, recursive (`logical_path ILIKE 'photos/2026/%'` with escaping);
- search query (`ILIKE` on both path and filename; `%`/`_` in the query are escaped);
- listing with `showImages=false` (`media_type NOT IN ('image','gif')`) and `showVideos=false`;
- listing with a valid cursor for `date-newest` (cursor condition present, `LIMIT limit+1`).

Fold `media-page.ts` and `query-helpers.ts` cases into this file if they are still meaningful after
Step 3; delete those two files if they are now trivially thin, or keep them as internal seams —
executor's judgement, but the test file's name must match what it tests.

**Verify**: `repository.test.ts` imports from `./repository`; every branch of `resolveMediaScope` is
reachable through a repository-level test.

### Step 5: Manual smoke

With `pnpm dev:pane` and a folder holding more than 60 items:

- [ ] Each of the five sort modes lists, and "load more" appends without duplicates or gaps
      (compare against a full listing count).
- [ ] Shuffle → new random order; load more continues the same order; shuffle again → new order
      from page one.
- [ ] Toggle "show videos" off mid-list → list resets and excludes videos.
- [ ] Search with a `%` character in the query → no error, literal match.

## Test plan

Rendered-SQL tests are the primary coverage; they pin the SQL text and, separately, the
order/compare agreement invariant so a future edit to one side without the other fails loudly.
Cursor-seam tests are pure. No mocked drizzle chains — the executor stub is the only fake.

## Done criteria

- [ ] `repository.test.ts` tests `repository.ts`.
- [ ] Order-by and cursor comparison agreement is asserted for all five modes.
- [ ] A cursor with mismatched sort or seed is rejected at the seam.
- [ ] Condition builder and row mapper each exist once; `folderFromPath` and the twin type
      declarations are gone.
- [ ] `pnpm --filter @latch-works/pane-view check` passes; Step 5 checklist passes.

## STOP conditions

- Rendered SQL for the two read paths differs before and after Step 3 in any way other than
  parameter numbering — stop and find out why before proceeding.
- `LibraryMediaItem` turns out to carry fields `MediaItem` does not — keep it, do not alias.
- The client (`useGalleryBrowse`) is found to send cursors across a sort change — coordinate with
  Plan 048 before rejecting them server-side.

## Maintenance notes

The internal builders exist so the repository can be tested without a database; they are not an
interface for other modules to call. Reviewers should push back on any new module importing
`build*` from `repository.ts`. If a real test database is ever added (pglite), the rendered-SQL
tests stay as fast pins and a small integration suite runs the same request shapes end to end.
