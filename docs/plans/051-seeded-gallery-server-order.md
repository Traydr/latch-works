# Plan 051: One seeded server order for gallery media and comic summaries

> **Executor instructions**: Server and wire-format work only. The client's comic path keeps using
> `getLibrarySnapshot` with `mediaOffset` until Plan 052 switches it over; nothing in this plan may
> break it. Write the ordering tests and the pglite repository tests before changing any query. Do
> not replace global random ordering with per-page shuffling. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat bf8b0c8..HEAD -- apps/pane-view/src/server/library apps/pane-view/src/features/library apps/pane-view/src/features/gallery/useGalleryPreferences.ts apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle packages/media-domain/src`
> Plan 050 was folded into this plan as Step 0 on 2026-08-17; it is no longer a separate dependency.
> Re-read `repository.ts`, `gallery-listing.ts`, `library-service.ts`, and
> `packages/media-domain/src/comics.ts` before Step 1. If Plan 048 has landed, the seed field lives in
> its browse-state module rather than in `useGalleryPreferences.ts:59`; find it before Step 1.

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM. The comic summary query is new SQL; this plan runs it under pglite before it
  ships. The media cursor changes are pinned by Step 0's rendered-SQL tests. The natural collation
  (Decision 6) is proven against `compareByName` under pglite before any query uses it.
- **Depends on**: — (Plan 048 is not required; see the drift check for where the seed field lives).
- **Absorbs**: Plan 050 (2026-08-17) — its surviving steps are Step 0 below; its cursor tightening
  is superseded by Step 3.
- **Blocks**: 052
- **Category**: correctness / gallery ordering
- **Planned at**: commit `bf8b0c8`, 2026-08-15. Refined and split at `c8f46f4`, 2026-08-16; the
  client half moved to Plan 052.
- **Original finding**: focus-view pagination and random comic-order investigation, 2026-08-15

## Why this matters

Pane View has two pagination models. Regular media uses a server keyset cursor with a seeded
`md5(seed:id)` order. Comic mode fetches media by `mediaOffset` in logical-path order, groups the
loaded subset on the client, and re-sorts the whole merged array after every page. Random comic
browsing therefore moves newly loaded entries above the user's scroll position, because the client
discovers a comic's random rank only after fetching it. The client and server also disagree on what
"random" means: `packages/media-domain/src/sort.ts:63-64` ranks by an FNV hash of the path;
`server/library/repository.ts:414` ranks by MD5 of the ID.

The fix needs one ordering contract owned by the server. For a fixed browse request and random seed,
the server defines one total order across the complete result set. Page 1 is the first slice of that
order, page 2 the next. Concatenating every page equals the unpaginated order exactly. Comics need a
cursor-paginated server listing of their own so the client never has to sort.

This plan delivers the server side of that contract and the wire format the client will consume.
Plan 052 delivers the client: one browse session, no client sort, and pagination-aware navigation.
The split keeps each PR reviewable and lets the server SQL be tested in isolation before the hottest
client file changes.

## Required behaviour

These are product requirements, not implementation suggestions.

1. **Random means one full-result permutation.** For a result set `S` and seed `r`, each eligible
   subject receives one deterministic random key. Sorting every subject by that key produces one
   permutation `P(S, r)`. Pagination slices `P`; it does not create separate random batches. Across
   uniformly generated seeds, every subject has the same chance of occupying each position.
2. **The same request and seed are stable.** Reloading a page, retrying a request, or loading another
   page returns the same order while the seed stays unchanged.
3. **Shuffle changes the full order.** A new seed changes the complete permutation, including the
   first page.
4. **Every gallery mode uses the contract.** It applies to regular folders, recursive folders,
   filtered media, searches, and comics. A regular browse subject is one media item. A comic browse
   subject is one comic identified by its canonical folder path.
5. **No gaps or duplicates across pages of a fixed population.** For an unchanged result set, a
   subject appears exactly once in the concatenated result. Population changes between requests
   (deletes, sync) are handled by the client policy in Plan 052; the server guarantees the keyset
   property only.
6. **Filters do not reorder.** Under one seed, toggling `showImages`/`showVideos` or changing the
   query removes or adds subjects but never changes the relative order of the subjects that remain.
   This falls out of keying by subject identity alone; test it, because it is cheap and it catches
   any accidental dependence on position or filter state.

Folder navigation cards are not random browse subjects. Keep folder cards in their current section
and order. Random ordering applies to media and comics.

For 1,000 subjects and a page size of 48, page 1 is `P[0..47]`, page 2 is `P[48..95]`, and so on.
Any subject may occupy any position in `P`. A new seed changes the whole `P`, not only the order
inside each 48-subject slice.

## Current state

All references are to `apps/pane-view/src/` unless another root is named.

- `server/library/repository.ts:396-425` orders random media by
  `md5(concat(seed::text, ':', entry.id::text))` with `logicalPath, id` tie-breakers; `:483-506`
  continues from that order. This is the right shape for a global seeded permutation. Non-random
  modes order by `filename`/`mtimeMs` in PostgreSQL byte order (`:417-421`), not by the natural
  collator the client uses.
- `server/library/gallery-listing.ts:16-24` cursor payload carries `randomSeed?: number` and
  `randomHash?: string`; `:32-58` decode does not check them against the request. Step 3 tightens
  this.
- `features/library/library-service.ts:35` validates `randomSeed: z.number().int().nonnegative()`;
  `:136-138` rejects comic mode from `getGalleryListing`.
- `features/gallery/useGalleryPreferences.ts:59,225` creates the seed with
  `createRandomSeed()` from `media-domain` (`Date.now() ^ Math.random()`, a 31-bit number, not
  persisted). Plan 048 moves and persists this field.
- Comic mode uses `getLibrarySnapshot` with `mediaOffset`. `repository.ts:96-110` orders the source
  rows by `logicalPath, id`, not the requested gallery order.
- `packages/media-domain/src/comics.ts:38-104` (`buildComicEntries`) defines comic eligibility:
  `mediaType` is `image` or `gif`; the parent folder is not the browse root; with `leafFoldersOnly`,
  the folder has no child folder in `allFolders` (non-deleted). Cover = first page under
  `compareByName`, which uses `Intl.Collator({ numeric: true, sensitivity: "base" })`
  (`sort.ts:3-6`). Comic `id` = folder path.
- `comics.ts:106-118` (`sortComicEntries`) sorts comics by their **cover's** filename/path/mtime, not
  by comic name. Random uses `hash(seed:coverPath)`. The current "comic name order" is therefore an
  accident of cover filenames.
- `server/db/schema.ts:248,281`: `folders.parent_path` and `library_entries.parent_path` are both
  indexed. `folders.deleted_at` and `library_entries.deleted_at` are indexed. `folders` has no
  mtime column.
- `drizzle/0008_gallery_query_indexes.sql` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm`. Any
  in-process test database must load that extension before migrating.
- No repository test executes SQL. Every server test mocks `../db` (`vi.mock("../db", ...)`).
  `repository.test.ts` imports only `media-page.ts` and `query-helpers.ts`, nothing from
  `repository.ts`; the 97-line keyset builder and the duplicated condition block (`repository.ts:57-91`
  vs `:214-250`) and row mapper (`:151-167` vs `:530-548`) are untested. Step 0 pins them with
  rendered SQL; Step 2 adds pglite for behaviour.
- Regular media name modes order by `filename` in PostgreSQL byte order (`repository.ts:417`), so
  Pane View lists `10.jpg` before `2.jpg` today while Frame View and the comic reader use the natural
  collator. Decision 6 fixes this for media and comics alike.
- Plan 025 landed on 2026-08-17: `drizzle/meta/0017_snapshot.json` is current, so
  `drizzle-kit generate --custom` now copies a correct snapshot and is the right way to add the
  hand-written `CREATE COLLATION` migration in Decision 6.
- `features/comics/ComicReader.tsx` requires a full `ComicEntry` with every page. Returning every
  page for every comic in a listing page would make the listing payload unbounded.

## Feedback loops

Create these tests before the implementation. Fixed subject IDs, fixed seeds, no live randomness.

| Signal | Command | Failure before the fix |
|---|---|---|
| Pure random key | `pnpm --dir apps/pane-view exec vitest run src/server/library/gallery-order.test.ts` | Key helper does not exist. |
| Executed media cursor | `pnpm --dir apps/pane-view exec vitest run src/server/library/gallery-listing.pglite.test.ts` | Cursor with a mismatched seed or subject kind is accepted; concatenated random pages under the shared key differ from the oracle. |
| Executed comic cursor | same file | `getGalleryListing` rejects comic mode; no comic summary rows exist. |
| Rendered SQL | `pnpm --dir apps/pane-view exec vitest run src/server/library/repository.test.ts` | Step 0's pinned SQL strings change without a recorded reason. |
| Natural collation | same pglite file | `ORDER BY filename COLLATE "natural"` disagrees with `compareByName` over the fixture. |

The pglite tests are the only place concatenation equality is proven against SQL that actually
executes. The rendered-SQL tests from Step 0 remain the cheap guard against accidental query
rewrites. Both stay.

## Scope

**In scope**: a shared server ordering key; a 32-hex-character seed on the wire and in the cursor;
cursor validation against subject kind and seed; a cursor-paginated comic summary listing served by
`getGalleryListing`; a server function that resolves one comic summary into a full `ComicEntry`; a
pglite test harness for the library repository; the request and response types those changes need;
the minimal client change required to send the new seed format.

**Out of scope**: any change to how the client accumulates, sorts, or navigates pages (Plan 052);
switching comic mode off `getLibrarySnapshot` (Plan 052); changing the persisted page size;
randomizing folder cards; changing Frame View's local archive sort or `media-domain`'s
`createRandomSeed`; cryptographic secrecy for the seed; table or column changes (the one migration
this plan adds is `CREATE COLLATION`, Decision 6); comic-reader page virtualization.

## Decisions taken in this plan

1. **The server owns presentation order.** Every listing page is returned in final display order.
   Plan 052 forbids client sorting of accumulated pages; this plan makes that possible.
2. **Random rank is `md5(seed || ':' || kind || ':' || id)`.** One helper computes it in TypeScript
   and one SQL fragment computes it in PostgreSQL; a test proves they agree byte for byte. The kind
   prefix keeps a media ID and a comic folder path from sharing a rank input by accident. Fixed-width
   lowercase hex means lexical order agrees between SQL `text` comparison and JavaScript string
   comparison. The hash is for ordering, not security.
3. **The seed is a validated 32-character lowercase hex string**, generated from 16 bytes of
   `crypto.getRandomValues`. It is required on every listing request (it is required today) and is
   embedded in every cursor. A cursor whose seed, sort mode, or subject kind differs from the request
   is rejected (`decode` returns `null` → first page). Any persisted or
   in-memory numeric seed is replaced with a fresh hex seed on load; nothing migrates old values.
4. **Comic listing returns summaries.** `GalleryComicSummary` carries the canonical folder path as
   `id`, the display name, the cover `LibraryMediaItem`, and `pageCount`. Full pages load only when the
   reader opens (Step 5's server function).
5. **The comic query is two-phase; an aggregate scan is acceptable, an unbounded result is not.**
   Phase 1 aggregates eligible entries by `parent_path` (count, min/max mtime), joins the leaf-folder
   test, orders by the requested mode, and takes `limit + 1` rows. Phase 2 fetches the cover row for
   only those folder paths. Ranking every comic requires touching every eligible entry, which is the
   same cost class as the existing random media order (`ORDER BY md5(...)` sorts the whole population
   per page). Both `parent_path` columns are indexed. What must never happen is returning every media
   row to the service layer.
6. **Name ordering and cover choice use a natural, case-insensitive collation on the server,
   matching `compareByName`.** Product owner confirmed natural ordering on 2026-08-17; byte order was
   rejected. Add one hand-written migration via
   `SKIP_ENV_VALIDATION=1 pnpm --filter @latch-works/pane-view db:generate --custom --name natural_collation`
   whose body is `CREATE COLLATION IF NOT EXISTS "natural" (provider = icu, locale = 'und-u-kn-true-ks-level1');`
   (`kn-true` = numeric digit runs, `ks-level1` = primary strength, i.e. case- and accent-insensitive
   like `Intl.Collator({ numeric: true, sensitivity: "base" })`). Keep the collation deterministic
   (the default) so equal-at-primary strings still tie-break bytewise and `ILIKE`/`pg_trgm` on the
   columns are unaffected — the collation is applied per expression (`filename COLLATE "natural"`),
   never to the column definition. Drizzle does not model collations, so `0017_snapshot.json` stays
   current and a later `db:generate` sees no drift. Concretely:
   - regular media `name-asc`/`name-desc` = `filename COLLATE "natural"`, then
     `logicalPath COLLATE "natural"`, then `id`; the keyset cursor compares with the same collation;
   - cover = the eligible page with the smallest `(filename COLLATE "natural", id)` — the same page
     `compareByName` puts first, so card cover and reader cover agree;
   - comic `name-asc` / `name-desc` = `folderPath COLLATE "natural"` asc/desc (folder path is unique);
   - `date-newest` = `max(page mtime)` desc, then `folderPath COLLATE "natural"` asc;
   - `date-oldest` = `min(page mtime)` asc, then `folderPath COLLATE "natural"` asc;
   - `random` = shared key over `("comic", folderPath)`, then `folderPath` asc.
   Prove it in pglite: sort the fixture's filenames with `ORDER BY filename COLLATE "natural", id` and
   with `compareByName` (with an `id` tie-break added to the oracle, since the collator returns 0 for
   primary-equal names such as `A.jpg`/`a.jpg`); the two lists must be identical. A disagreement on
   the ASCII fixture is a STOP condition. Do not add expression indexes in this plan; note in the PR
   whether `EXPLAIN` under Docker Postgres shows a full sort per page for name modes (random already
   does), and leave indexes to a follow-up.
   Known visible changes: regular media name order becomes natural (`2.jpg` before `10.jpg`); comics
   were previously ordered by cover filename, now by folder path; date order uses newest/oldest page
   instead of the cover's mtime. Record these in the PR description.
7. **Comic eligibility matches `buildComicEntries` exactly**: `media_type IN ('image','gif')`;
   `deleted_at IS NULL`; entry inside the normalized browse scope (comic mode forces recursive, so
   subtree prefix); `parent_path <> currentPath`; `NOT EXISTS` a non-deleted `folders` row whose
   `parent_path` equals the entry's `parent_path`; the search query and `showImages`/`showVideos`
   apply to pages before grouping, so a search lists only comics with a matching page and counts only
   matching pages. `pageCount` is therefore the eligible page count under the current filters.
8. **pglite is the repository test adapter.** A brand-new aggregate query with a keyset cursor and a
   collation change need executed SQL, not string pins. Add `@electric-sql/pglite` as a pane-view
   devDependency, build the schema by running the checked-in `drizzle/` migrations (through the
   collation migration) via `drizzle-orm/pglite/migrator` with the `pg_trgm` contrib extension
   loaded, and inject the resulting `db` via `vi.mock("../db", ...)`. PGlite is built with ICU
   (`initDbStartParams` accepts `--locale-provider=icu`); the `und` root collation with `kn`/`ks`
   attributes needs no extra locale data, but if `CREATE COLLATION` fails under the default build,
   switch the devDependency to the `pglite-icu-full` build before falling back to hand-written DDL.
   Rendered-SQL tests (Step 0) stay for the builders; pglite tests cover behaviour. This harness is
   also the intended base for Plan 049's worker tests.
9. **The wire changes are additive.** `getGalleryListing` accepts `comicMode: true` and returns
   summaries; the response type gains `subjectKind` and `comics`. `getLibrarySnapshot` is untouched.
   The only client change is the seed format, because the server schema will reject numeric seeds.

## Proposed interfaces

```ts
// server/library/gallery-order.ts
export type GallerySubjectKind = "media" | "comic";
/** 32 lowercase hexadecimal characters. */
export type GalleryRandomSeed = string;
export const GALLERY_RANDOM_SEED_PATTERN = /^[0-9a-f]{32}$/;
export function isGalleryRandomSeed(value: unknown): value is GalleryRandomSeed;
export function galleryRandomOrderKey(
  seed: GalleryRandomSeed,
  subjectKind: GallerySubjectKind,
  subjectId: string,
): string; // 32 lowercase hex characters
export function galleryRandomOrderKeySql(
  seed: GalleryRandomSeed,
  subjectKind: GallerySubjectKind,
  subjectId: SQL | AnyPgColumn,
): SQL;

// features/gallery/gallery-random-seed.ts (client)
export function createGalleryRandomSeed(previous?: GalleryRandomSeed | null): GalleryRandomSeed;
// Uses crypto.getRandomValues; loops if the result equals `previous`.

// server/library/gallery-listing.ts
export interface GalleryComicSummary {
  cover: LibraryMediaItem;
  folderPath: string;
  id: string; // === folderPath
  name: string;
  pageCount: number;
}

export interface GalleryListingPage {
  subjectKind: GallerySubjectKind;
  entries: BrowserEntry[];        // media mode: folder + media entries as today; comic mode: []
  media: LibraryMediaItem[];      // media mode: page media; comic mode: covers in listing order
  comics: GalleryComicSummary[];  // media mode: []; comic mode: summaries in listing order
  page: { cursor: string | null; hasMore: boolean; limit: number };
}

export type GalleryListingCursorPayload =
  | {
      subjectKind: "media";
      sortMode: GallerySortMode;
      randomSeed: GalleryRandomSeed;
      randomKey?: string;
      filename: string;
      id: string;
      logicalPath: string;
      mtimeMs: number;
    }
  | {
      subjectKind: "comic";
      sortMode: GallerySortMode;
      randomSeed: GalleryRandomSeed;
      randomKey?: string;
      folderPath: string;
      mtimeMs: number; // max or min page mtime, per sort mode
    };

// features/library/library-service.ts
export const getGalleryComic: ServerFn<
  { comicId: string; path?: string; query?: string; showImages?: boolean; showVideos?: boolean },
  ComicEntry<LibraryMediaItem>
>;
```

`decodeGalleryListingCursor(encoded, request)` takes the request and returns `null` on any
mismatch of `subjectKind`, `sortMode`, or `randomSeed`.

## Git workflow

- Branch: `agent/051-gallery-server-order`
- Commit message: `Add one seeded server order for gallery media and comics`

## Steps

### Step 0: Prepare the repository (absorbed from Plan 050)

Before touching ordering, pin and dedupe `server/library/repository.ts` (548 lines, no direct
test):

- Split query building from execution: export internal builders `buildGalleryListingMediaQuery`,
  `buildGalleryListingOrderBy`, and `buildGalleryListingCursorCondition` for the test file; the
  `readDatabase*` functions execute them. These are internal seams, not an interface for other
  modules — reviewers should reject imports of `build*` from outside the test.
- Extract `buildLibraryConditions({ currentPath, query, recursive })` returning
  `{ mediaConditions, folderConditions }` from the duplicated block at `repository.ts:57-91` /
  `:214-250`; both read paths call it, and Step 4's comic eligibility reuses it.
- Delete the inline row mapper (`:151-167`) in favour of `mapMediaRowsToLibraryItems`; delete
  `folderFromPath` (`:182-190`, no callers); collapse the twin `LibraryMediaItem` / `MediaPage`
  declarations in `server/library/types.ts`, `features/library/types.ts`, and `media-page.ts` into
  one, aliasing `LibraryMediaItem = MediaItem` if it adds nothing (STOP and keep it if it does).
- Rewrite `repository.test.ts` so it imports from `./repository`, in the
  `server/auth/login-throttle-sql.test.ts` style (stub executor, `.toSQL()`): render `ORDER BY` and
  the cursor `WHERE` for all five sort modes and assert programmatically that direction agrees
  (`desc` column ⇒ `<` in the leading disjunct, `asc` ⇒ `>`); render both read paths for root
  non-recursive, recursive subtree with `%`/`_` escaping, search on path and filename,
  `showImages=false`, and a `date-newest` cursor with `LIMIT limit+1`. Fold `media-page.ts` and
  `query-helpers.ts` cases into this file and delete those files if trivially thin.

Not carried over from Plan 050: its cursor-mismatch tightening (`expected` argument, `?? 0` / `?? ""`
removal) — Step 3 replaces the cursor payload wholesale, so doing it twice is waste.

**Verify**: rendered SQL for both read paths is identical before and after the dedupe except for
parameter numbering (STOP if not); `repository.ts` shrinks by roughly 80 lines; `pnpm typecheck` and
the pane test suite pass. Commit Step 0 on its own so the ordering diff in Step 3 is reviewable.

### Step 1: Pin the ordering key and the seed format

Add `server/library/gallery-order.ts` per the interface above. `galleryRandomOrderKey` is
`createHash("md5").update(`${seed}:${kind}:${id}`).digest("hex")`; the SQL fragment is
`md5(concat(${seed}::text, ':', ${kind}::text, ':', ${subjectId}::text))`.

Add the client seed helper. Replace `createRandomSeed()` at `useGalleryPreferences.ts:59,225` (or in
Plan 048's module) with `createGalleryRandomSeed(current)`. Change the client `randomSeed` type to
`GalleryRandomSeed`. Change `library-service.ts:35` to
`z.string().regex(GALLERY_RANDOM_SEED_PATTERN)`. Any persisted value that fails the pattern is
replaced with a fresh seed on load. Do not change `media-domain`'s `createRandomSeed`; Frame View
still uses it.

Add `gallery-order.test.ts` with 1,000 fixture subjects (mixed media IDs and comic folder paths,
including 200 IDs that share a common prefix such as `folder-a/…`) and 16 fixed seeds:

- the same seed and subject set produce the same permutation;
- input order does not change the permutation;
- each permutation contains every subject exactly once;
- every seed produces a distinct permutation and a distinct first 48;
- for each pair of consecutive fixed seeds, the fraction of subjects that stay in the same position
  quartile is at most 0.35 (expected 0.25 for independent keys; a seed that is ignored or a broken
  constant scores 1.0);
- for each seed, the 200 common-prefix subjects occupy at least 15% of each position quartile
  (expected 25%; a path-prefix rank scores 0 in three of four quartiles);
- `galleryRandomOrderKey("…", "media", "x")` differs from `galleryRandomOrderKey("…", "comic", "x")`;
- `createGalleryRandomSeed` returns 32 lowercase hex characters and never returns its `previous`
  argument (inject `getRandomValues` for that case).

Record the 16 seeds and the tolerances in the test file with a comment explaining what each bound
catches. The bounds are deterministic for the fixed seeds; if a future seed list trips one, change
the seeds, not the bound.

**Verify**: the pure tests pass. `pnpm --filter @latch-works/pane-view check` passes with the seed
type change.

### Step 2: Stand up the pglite repository harness

Add `@electric-sql/pglite` as a devDependency. Add `server/library/test-db.ts` (test-only) that
creates a `PGlite` with `extensions: { pg_trgm }`, wraps it in `drizzle-orm/pglite` with the schema,
and runs `migrate` from `drizzle-orm/pglite/migrator` against `apps/pane-view/drizzle`. If a
migration statement fails under pglite, note which one and fall back to creating only `folders`,
`library_entries`, and `media_objects` from hand-written DDL derived from `schema.ts`; do not silently
skip migrations. Expose `seedLibraryFixture(db, fixture)` that inserts folders, media objects, and
entries.

Build one deterministic fixture used by every pglite test in this plan:

- three roots; a mix of leaf folders and folders with child folders;
- at least 1,200 media entries with fixed UUIDs, mixed `image`/`gif`/`video`, fixed mtimes with
  duplicates, and some soft-deleted rows;
- comics with padded and unpadded page names (`001.jpg`; `2.jpg`,`10.jpg`) so cover selection is
  exercised;
- some media directly under a browse root (must not form a comic);
- filenames that match and do not match a fixture search term.

Add the in-memory oracle: given the fixture and a request, compute the expected full order in
TypeScript using the same key helper and the tie-breaker rules in Decision 6. Keep the oracle in the
test file; it is a test double, not production code.

**Verify**: a smoke test inserts the fixture and reads back row counts. Runtime for the whole file
stays under ten seconds locally.

### Step 3: Make the media cursor use the shared key and validate the cursor

Route regular media random ordering through `galleryRandomOrderKeySql(seed, "media", entry.id)`.
Keep the existing tie-breakers. Change the cursor payload to the discriminated shape; add
`subjectKind` and require `randomSeed`. `decodeGalleryListingCursor` takes the request and rejects
any mismatch.

Apply Decision 6 to the name modes: `filename COLLATE "natural"` (and `logicalPath COLLATE
"natural"`) in `ORDER BY` and in the cursor comparison. Update Step 0's rendered-SQL tests for the
new key expression and the collation (this is a recorded, intended change to the pinned strings).
Add the collation migration first (Decision 6) so pglite and Docker both have it.

In `gallery-listing.pglite.test.ts`, for each of these request shapes — non-recursive folder,
recursive subtree, search, `showImages` only, `showVideos` only — and each sort mode, and page sizes
`{7, 48, 100}`, and two fixed seeds for random: collect all pages by following cursors and assert
that the concatenated IDs equal the oracle exactly. Assert that a cursor built for seed A is rejected
under seed B and returns page 1. Assert Required behaviour 6: for one seed, the random order of the
`showImages`-only result is a subsequence of the unfiltered random order.

**Verify**: regular media keeps its append-only behaviour; no duplicates or gaps for a fixed
population; changing the seed invalidates the old cursor.

### Step 4: Add the cursor-paginated comic summary listing

Extend `readDatabaseGalleryListing` (or add `readDatabaseComicListing` behind the same service call)
for `subjectKind: "comic"`.

Phase 1 SQL, in one statement: `SELECT parent_path, count(*) AS page_count, max(mtime_ms), min(mtime_ms)
FROM library_entries e JOIN media_objects … WHERE <eligibility from Decision 7> GROUP BY parent_path
HAVING NOT EXISTS (SELECT 1 FROM folders f WHERE f.parent_path = e.parent_path AND f.deleted_at IS NULL)
ORDER BY <mode> LIMIT limit + 1`, with the cursor condition applied in `HAVING` (or a wrapping
subquery) because it references aggregates in date modes. In random mode, order by
`galleryRandomOrderKeySql(seed, "comic", parent_path)`, then `parent_path`.

Phase 2 SQL: `SELECT DISTINCT ON (parent_path) … WHERE parent_path IN (<page folder paths>) AND
<eligibility> ORDER BY parent_path, filename, id`. Map rows to `LibraryMediaItem` with the existing
mapper. Build `GalleryComicSummary` with `name = displayNameFromPath(folderPath)`.

Encode the comic cursor from the last summary of the page. Change `getGalleryListing` to accept
`comicMode: true`, derive `subjectKind: "comic"`, and remove the rejection at
`library-service.ts:136-138`. In comic mode `entries` is `[]` and `media` is the covers.

Add pglite tests: for page sizes `{3, 7, 48}`, every sort mode, two seeds, with and without the
search term and each visibility filter, concatenated comic pages equal the oracle; page 1 is a prefix
of the concatenation; the root-level media never forms a comic; a folder with a child folder is
never a comic; a soft-deleted page is not counted; the unpadded-name comic's cover is `1.jpg`/`2.jpg`, not
`10.jpg` (natural minimum, agreeing with `compareByName`). Add one rendered-SQL assertion for each phase so the query shape is pinned.

**Verify**: with one seed, a comic can appear on any page according to its global rank. Loading page 2
never changes page 1. The listing payload contains no `pages` arrays.

### Step 5: Add the comic-by-id server function

Add `getGalleryComic` per the interface. It authorizes the web session, normalizes `path`, and
validates that `comicId` is a folder path inside the browse scope (reject otherwise). It selects
every eligible page of that one folder under the same eligibility rules and the same `query`,
`showImages`, `showVideos` as the listing, sorts them with `compareByName` in TypeScript, and returns
a `ComicEntry<LibraryMediaItem>` whose `cover` is `pages[0]` under natural order — the same page
the card shows, because Decision 6 uses the same natural collation server-side.

Add a pglite test that resolves each fixture comic and compares page order to `buildComicEntries`
run over the same fixture rows, proving that the reader sees exactly what the old client grouping
produced. Add a test that a `comicId` outside `path` is rejected.

**Verify**: response size depends on that comic's page count only. Search narrows pages, matching
the current grouping behaviour.

### Step 6: Confirm the client still works unchanged

Run `pnpm dev:pane`. Regular browsing in every sort mode still paginates; comic mode still browses
through the snapshot path (unchanged); Shuffle produces a hex seed and a new order. Nothing in the
client reads `comics` yet.

- [ ] Regular folder, Random: load three pages, no repeated or missing items compared to a reload
      with the same seed.
- [ ] Recursive + search + image-only: same.
- [ ] Comic mode: unchanged behaviour (still client-sorted; Plan 052 fixes it).
- [ ] Shuffle: URL/localStorage seed is 32 hex characters; order changes.

## Verification commands

| Purpose | Command | Expected on success |
|---|---|---|
| Ordering, cursor, comic listing | `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` | All order, pglite, rendered-SQL, and service tests pass. |
| Shared domain | `pnpm --filter @latch-works/media-domain test` | Unchanged; Frame View behaviour intact. |
| Pane check | `pnpm --filter @latch-works/pane-view check` | Exit 0. |
| Workspace typecheck | `pnpm typecheck` | Exit 0. |

## Done criteria

- [ ] One documented random-order function defines the server order for media and comics, and a
      test proves the TypeScript and SQL keys agree.
- [ ] The seed is a validated 32-hex string on the request and in every cursor; a mismatched cursor
      is rejected.
- [ ] `getGalleryListing` serves comic summaries with a keyset cursor; the payload has no `pages`.
- [ ] `getGalleryComic` returns one complete comic in natural page order.
- [ ] pglite tests prove concatenated pages equal the fixed-seed order for regular, recursive,
      filtered, searched, and comic requests at three page sizes and two seeds each.
- [ ] Filtering under one seed yields a subsequence of the unfiltered order.
- [ ] Rendered-SQL tests are updated with a recorded reason for every changed string.
- [ ] The `natural` collation exists via a hand-written migration; server name order and cover
      choice agree with `compareByName` over the pglite fixture; Decision 6's visible changes are
      listed in the PR description.
- [ ] Step 0 landed first: `repository.test.ts` tests `repository.ts`, order/cursor direction
      agreement is asserted for all five modes, and the condition builder and row mapper exist once.
- [ ] The client still browses in every mode; Shuffle produces a hex seed.
- [ ] `pnpm --filter @latch-works/pane-view check` passes.

## STOP conditions

- The product owner wants folder navigation cards included in the random permutation. This plan
  treats only media and comics as random subjects.
- `CREATE COLLATION … provider = icu` fails under pglite (even with `pglite-icu-full`) or under
  the production PostgreSQL, or the collation disagrees with `compareByName` on the ASCII fixture.
  Record the failure; the fallback is an immutable SQL natural-key function (`lower` + zero-padded
  digit runs) used in the same `ORDER BY`/cursor positions, which is a different plan step, not a
  silent substitution.
- The comic summary query returns every eligible media row to the service layer before applying its
  page limit. Aggregation over eligible rows is expected; unbounded transfer is not.
- pglite cannot run the checked-in migrations and the hand-written DDL fallback would need to
  diverge from `schema.ts` in any way that affects these queries. Record the failing statement.
- Search is meant to list a matching comic but open every page in that comic. Current grouping only
  includes matching pages and this plan preserves that. That product change needs an explicit
  decision before Step 5.

## Maintenance notes

The server response order is authoritative. New browse modes must identify their subject kind, use
the shared seeded key, validate cursors against the request, and pass the concatenated-page equality
tests under pglite. Reviewers should reject a listing that returns rows in an order other than the
one the cursor continues.

Step 0's rendered-SQL tests remain the guard against accidental builder rewrites; the pglite tests
are the guard for behaviour. Keep both. Plan 052 owns the client: accumulation, the population-change
policy, and navigation across page boundaries.
