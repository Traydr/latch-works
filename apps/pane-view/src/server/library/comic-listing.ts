import type { ComicEntry, GallerySortMode } from "@latch-works/media-domain";
import { compareByName, displayNameFromPath } from "@latch-works/media-domain";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  max,
  min,
  ne,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Database, db } from "../db";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import {
  cursorRandomKey,
  DEFAULT_GALLERY_LISTING_LIMIT,
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  type GalleryComicSummary,
  type GalleryListingCursorPayload,
  type GalleryListingPage,
} from "./gallery-listing";
import {
  type GalleryRandomSeed,
  galleryRandomOrderKey,
  galleryRandomOrderKeySql,
  naturalOrder,
} from "./gallery-order";
import { type KeysetColumn, keysetAfter, keysetOrderBy } from "./keyset-order";
import {
  buildLibraryConditions,
  buildMediaVisibilityConditions,
  mapMediaRowsToLibraryItems,
} from "./library-conditions";
import type { LibraryMediaItem } from "./types";

export interface ComicListingReadRequest {
  currentPath: string;
  cursor?: string;
  /**
   * Direct-child subtrees to subtract (Plan 054). Listing-only: the reader's
   * single-comic fetch (ComicReadRequest) stays exclude-free — an excluded
   * comic simply never appears in the listing.
   */
  excludedPaths?: readonly string[];
  limit?: number;
  query?: string;
  randomSeed: GalleryRandomSeed;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

export interface ComicReadRequest {
  comicId: string;
  currentPath: string;
  query?: string;
  showImages: boolean;
  showVideos: boolean;
}

type ComicCursor = Extract<GalleryListingCursorPayload, { subjectKind: "comic" }>;

// ---------------------------------------------------------------------------
// Eligibility (Plan 051, Decision 7) — must match media-domain's
// buildComicEntries: image/gif pages, not deleted, inside the browse scope
// (comic mode is always recursive), not directly under the browse root, and
// only in folders with no live child folder. Search and visibility filters
// apply to pages before grouping.
// ---------------------------------------------------------------------------

/** Page-level eligibility for a comic subject in scope. */
function buildComicPageConditions({
  currentPath,
  excludedPaths,
  query,
  showImages,
  showVideos,
}: Pick<
  ComicListingReadRequest,
  "currentPath" | "excludedPaths" | "query" | "showImages" | "showVideos"
>): SQL[] {
  const { mediaConditions } = buildLibraryConditions({
    currentPath,
    excludedPaths,
    query,
    recursive: true,
  });

  return [
    ...mediaConditions,
    inArray(mediaObjects.mediaType, ["image", "gif"]),
    ...buildMediaVisibilityConditions({ showImages, showVideos }),
    ne(libraryEntries.parentPath, currentPath),
  ];
}

/** True when the entry's folder has no live child folder, i.e. it is a leaf. */
function leafFolderCondition(database: Database): SQL {
  return notExists(
    database
      .select({ one: sql`1` })
      .from(folders)
      .where(and(eq(folders.parentPath, libraryEntries.parentPath), isNull(folders.deletedAt))),
  );
}

const pageCount = count().as("page_count");

const newestMtime = max(libraryEntries.mtimeMs).as("newest_mtime");

const oldestMtime = min(libraryEntries.mtimeMs).as("oldest_mtime");

/**
 * Comic listing order (Plan 051, Decision 6). Name modes use the natural
 * collation over the folder path (unique, so no further tie-break); date
 * modes rank by the newest or oldest page and tie-break by natural path;
 * random uses the shared seeded key over ("comic", folderPath). The cursor
 * condition goes in HAVING, since the date modes order by aggregates.
 */
function comicListingOrder(
  sortMode: GallerySortMode,
  randomSeed: GalleryRandomSeed,
): KeysetColumn<ComicCursor>[] {
  const folderPath = libraryEntries.parentPath;

  const naturalPath = (direction: "asc" | "desc"): KeysetColumn<ComicCursor> => ({
    cursorValue: (cursor) => cursor.folderPath,
    direction,
    expression: naturalOrder(folderPath),
  });

  const pageMtime = (direction: "asc" | "desc", mtime: SQL): KeysetColumn<ComicCursor> => ({
    cursorValue: (cursor) => cursor.mtimeMs,
    direction,
    expression: mtime,
  });

  switch (sortMode) {
    case "name-desc":
      return [naturalPath("desc")];
    case "date-newest":
      return [pageMtime("desc", max(libraryEntries.mtimeMs)), naturalPath("asc")];
    case "date-oldest":
      return [pageMtime("asc", min(libraryEntries.mtimeMs)), naturalPath("asc")];
    case "random":
      return [
        {
          cursorValue: cursorRandomKey,
          direction: "asc",
          expression: galleryRandomOrderKeySql(randomSeed, "comic", folderPath),
        },
        { cursorValue: (cursor) => cursor.folderPath, direction: "asc", expression: folderPath },
      ];
    default:
      return [naturalPath("asc")];
  }
}

/**
 * Phase 1: one aggregate row per eligible comic folder, in listing order,
 * overfetched by one. Touches every eligible page (the same cost class as the
 * random media order) but returns only `limit + 1` rows.
 */
function buildComicSummaryQuery(
  {
    currentPath,
    cursor,
    excludedPaths,
    limit = DEFAULT_GALLERY_LISTING_LIMIT,
    query,
    randomSeed,
    showImages,
    showVideos,
    sortMode,
  }: Omit<ComicListingReadRequest, "cursor"> & { cursor: ComicCursor | null },
  database: Database = db,
) {
  const conditions = buildComicPageConditions({
    currentPath,
    excludedPaths,
    query,
    showImages,
    showVideos,
  });

  const order = comicListingOrder(sortMode, randomSeed);

  return database
    .select({
      folderPath: libraryEntries.parentPath,
      newestMtime,
      oldestMtime,
      pageCount,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...conditions, leafFolderCondition(database)))
    .groupBy(libraryEntries.parentPath)
    .having(cursor ? keysetAfter(order, cursor) : undefined)
    .orderBy(...keysetOrderBy(order))
    .limit(limit + 1);
}

/**
 * Phase 2: the cover for each listed folder — its first eligible page under
 * the natural collation, then id, which is the page compareByName puts first.
 */
function buildComicCoverQuery(
  {
    currentPath,
    folderPaths,
    query,
    showImages,
    showVideos,
  }: Pick<ComicListingReadRequest, "currentPath" | "query" | "showImages" | "showVideos"> & {
    folderPaths: string[];
  },
  database: Database = db,
) {
  const conditions = buildComicPageConditions({ currentPath, query, showImages, showVideos });

  return database
    .selectDistinctOn([libraryEntries.parentPath], {
      entry: libraryEntries,
      object: mediaObjects,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...conditions, inArray(libraryEntries.parentPath, folderPaths)))
    .orderBy(
      asc(libraryEntries.parentPath),
      asc(naturalOrder(libraryEntries.filename)),
      asc(libraryEntries.id),
    );
}

/** Every eligible page of one comic folder, unsorted; the caller orders them. */
function buildComicPagesQuery(
  { comicId, currentPath, query, showImages, showVideos }: ComicReadRequest,
  database: Database = db,
) {
  const conditions = buildComicPageConditions({ currentPath, query, showImages, showVideos });

  return database
    .select({
      entry: libraryEntries,
      object: mediaObjects,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(
      and(...conditions, eq(libraryEntries.parentPath, comicId), leafFolderCondition(database)),
    );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readDatabaseComicListing(
  {
    currentPath,
    cursor,
    excludedPaths,
    limit = DEFAULT_GALLERY_LISTING_LIMIT,
    query,
    randomSeed,
    showImages,
    showVideos,
    sortMode,
  }: ComicListingReadRequest,
  database: Database = db,
): Promise<GalleryListingPage> {
  const decodedCursor = decodeGalleryListingCursor(cursor, {
    randomSeed,
    sortMode,
    subjectKind: "comic",
  });

  const summaryRows = await buildComicSummaryQuery(
    {
      currentPath,
      cursor: decodedCursor?.subjectKind === "comic" ? decodedCursor : null,
      excludedPaths,
      limit,
      query,
      randomSeed,
      showImages,
      showVideos,
      sortMode,
    },
    database,
  );

  const hasMore = summaryRows.length > limit;
  const pageRows = hasMore ? summaryRows.slice(0, limit) : summaryRows;
  const folderPaths = pageRows.map((row) => row.folderPath);

  const coverRows =
    folderPaths.length > 0
      ? await buildComicCoverQuery(
          { currentPath, folderPaths, query, showImages, showVideos },
          database,
        )
      : [];

  const coverByFolder = new Map(
    mapMediaRowsToLibraryItems(coverRows).map((cover) => [cover.parentPath, cover]),
  );

  const comics: GalleryComicSummary[] = [];

  for (const row of pageRows) {
    const cover = coverByFolder.get(row.folderPath);

    if (!cover) {
      // A page vanished between the two phases; the next refetch reconciles.
      continue;
    }

    comics.push({
      cover,
      folderPath: row.folderPath,
      id: row.folderPath,
      name: displayNameFromPath(row.folderPath),
      pageCount: row.pageCount,
    });
  }

  const lastRow = pageRows.at(-1);

  const nextCursor =
    hasMore && lastRow
      ? encodeGalleryListingCursor({
          folderPath: lastRow.folderPath,
          mtimeMs:
            sortMode === "date-oldest" ? (lastRow.oldestMtime ?? 0) : (lastRow.newestMtime ?? 0),
          randomKey:
            sortMode === "random"
              ? galleryRandomOrderKey(randomSeed, "comic", lastRow.folderPath)
              : undefined,
          randomSeed,
          sortMode,
          subjectKind: "comic",
        })
      : null;

  return {
    comics,
    entries: [],
    media: comics.map((comic) => comic.cover),
    page: {
      cursor: nextCursor,
      hasMore,
      limit,
    },
    subjectKind: "comic",
  };
}

/**
 * Natural name order with the same tie-breaks the SQL cover choice uses:
 * collator, then bytewise name (the deterministic collation's tie-break),
 * then id. Card cover and reader cover therefore always agree, even for
 * primary-equal names such as "a.jpg" and "A.jpg".
 */
function compareComicPages(left: LibraryMediaItem, right: LibraryMediaItem): number {
  return (
    compareByName(left, right) ||
    compareBytewise(left.name, right.name) ||
    compareBytewise(left.id, right.id)
  );
}

function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * True when `comicId` names a folder the listing could have returned for
 * this scope. Browsing lists comics strictly inside the current path; a
 * search — like the regular media search — matches across the whole archive
 * and only excludes the current path itself, so a searched comic must open
 * from wherever it was found.
 */
function isComicInBrowseScope(comicId: string, currentPath: string, searching = false): boolean {
  if (!comicId || comicId === currentPath) {
    return false;
  }

  return searching || currentPath === "" || comicId.startsWith(`${currentPath}/`);
}

/** One complete comic in natural page order, or null when it has no eligible page. */
export async function readDatabaseGalleryComic(
  request: ComicReadRequest,
  database: Database = db,
): Promise<ComicEntry<LibraryMediaItem> | null> {
  if (!isComicInBrowseScope(request.comicId, request.currentPath, Boolean(request.query?.trim()))) {
    return null;
  }

  const rows = await buildComicPagesQuery(request, database);
  const pages = mapMediaRowsToLibraryItems(rows).sort(compareComicPages);
  const cover = pages[0];

  if (!cover) {
    return null;
  }

  return {
    cover,
    folderPath: request.comicId,
    id: request.comicId,
    name: displayNameFromPath(request.comicId),
    pages,
  };
}
