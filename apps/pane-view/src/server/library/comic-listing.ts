import type { ComicEntry, GallerySortMode } from "@latch-works/media-domain";
import { compareByName, displayNameFromPath } from "@latch-works/media-domain";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  min,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import {
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
} from "./gallery-order";
import {
  buildLibraryConditions,
  buildMediaVisibilityConditions,
  mapMediaRowsToLibraryItems,
} from "./library-conditions";
import { naturalOrder } from "./repository";
import type { LibraryMediaItem } from "./types";

export interface ComicListingReadRequest {
  currentPath: string;
  cursor?: string;
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

/**
 * Page-level eligibility for a comic subject in scope. Exported for the
 * rendered-SQL tests only.
 */
export function buildComicPageConditions({
  currentPath,
  query,
  showImages,
  showVideos,
}: Pick<ComicListingReadRequest, "currentPath" | "query" | "showImages" | "showVideos">): SQL[] {
  const { mediaConditions } = buildLibraryConditions({ currentPath, query, recursive: true });
  return [
    ...mediaConditions,
    inArray(mediaObjects.mediaType, ["image", "gif"]),
    ...buildMediaVisibilityConditions({ showImages, showVideos }),
    ne(libraryEntries.parentPath, currentPath),
  ];
}

/** True when the entry's folder has no live child folder, i.e. it is a leaf. */
function leafFolderCondition(): SQL {
  return notExists(
    db
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
 * random uses the shared seeded key over ("comic", folderPath).
 */
export function buildComicListingOrderBy(
  sortMode: GallerySortMode,
  randomSeed: GalleryRandomSeed,
): SQL[] {
  const folderPath = libraryEntries.parentPath;
  switch (sortMode) {
    case "name-desc":
      return [desc(naturalOrder(folderPath))];
    case "date-newest":
      return [desc(max(libraryEntries.mtimeMs)), asc(naturalOrder(folderPath))];
    case "date-oldest":
      return [asc(min(libraryEntries.mtimeMs)), asc(naturalOrder(folderPath))];
    case "random":
      return [asc(galleryRandomOrderKeySql(randomSeed, "comic", folderPath)), asc(folderPath)];
    default:
      return [asc(naturalOrder(folderPath))];
  }
}

/** Keyset continuation for buildComicListingOrderBy; goes in HAVING (date modes read aggregates). */
export function buildComicListingCursorCondition(cursor: ComicCursor): SQL {
  const requireCondition = (condition: SQL | undefined): SQL => {
    if (!condition) {
      throw new Error("Expected comic listing cursor condition");
    }
    return condition;
  };
  const folderPath = libraryEntries.parentPath;
  const naturalPath = naturalOrder(folderPath);

  switch (cursor.sortMode) {
    case "name-desc":
      return lt(naturalPath, cursor.folderPath);
    case "date-newest":
      return requireCondition(
        or(
          lt(max(libraryEntries.mtimeMs), cursor.mtimeMs),
          and(eq(max(libraryEntries.mtimeMs), cursor.mtimeMs), gt(naturalPath, cursor.folderPath)),
        ),
      );
    case "date-oldest":
      return requireCondition(
        or(
          gt(min(libraryEntries.mtimeMs), cursor.mtimeMs),
          and(eq(min(libraryEntries.mtimeMs), cursor.mtimeMs), gt(naturalPath, cursor.folderPath)),
        ),
      );
    case "random": {
      const key = galleryRandomOrderKeySql(cursor.randomSeed, "comic", folderPath);
      const cursorKey = cursor.randomKey ?? "";
      return requireCondition(
        or(gt(key, cursorKey), and(eq(key, cursorKey), gt(folderPath, cursor.folderPath))),
      );
    }
    default:
      return gt(naturalPath, cursor.folderPath);
  }
}

/**
 * Phase 1: one aggregate row per eligible comic folder, in listing order,
 * overfetched by one. Touches every eligible page (the same cost class as the
 * random media order) but returns only `limit + 1` rows.
 */
export function buildComicSummaryQuery({
  currentPath,
  cursor,
  limit = DEFAULT_GALLERY_LISTING_LIMIT,
  query,
  randomSeed,
  showImages,
  showVideos,
  sortMode,
}: Omit<ComicListingReadRequest, "cursor"> & { cursor: ComicCursor | null }) {
  const conditions = buildComicPageConditions({ currentPath, query, showImages, showVideos });

  return db
    .select({
      folderPath: libraryEntries.parentPath,
      newestMtime,
      oldestMtime,
      pageCount,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...conditions, leafFolderCondition()))
    .groupBy(libraryEntries.parentPath)
    .having(cursor ? buildComicListingCursorCondition(cursor) : undefined)
    .orderBy(...buildComicListingOrderBy(sortMode, randomSeed))
    .limit(limit + 1);
}

/**
 * Phase 2: the cover for each listed folder — its first eligible page under
 * the natural collation, then id, which is the page compareByName puts first.
 */
export function buildComicCoverQuery({
  currentPath,
  folderPaths,
  query,
  showImages,
  showVideos,
}: Pick<ComicListingReadRequest, "currentPath" | "query" | "showImages" | "showVideos"> & {
  folderPaths: string[];
}) {
  const conditions = buildComicPageConditions({ currentPath, query, showImages, showVideos });

  return db
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
export function buildComicPagesQuery({
  comicId,
  currentPath,
  query,
  showImages,
  showVideos,
}: ComicReadRequest) {
  const conditions = buildComicPageConditions({ currentPath, query, showImages, showVideos });

  return db
    .select({
      entry: libraryEntries,
      object: mediaObjects,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...conditions, eq(libraryEntries.parentPath, comicId), leafFolderCondition()));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readDatabaseComicListing({
  currentPath,
  cursor,
  limit = DEFAULT_GALLERY_LISTING_LIMIT,
  query,
  randomSeed,
  showImages,
  showVideos,
  sortMode,
}: ComicListingReadRequest): Promise<GalleryListingPage> {
  const decodedCursor = decodeGalleryListingCursor(cursor, {
    randomSeed,
    sortMode,
    subjectKind: "comic",
  });
  const summaryRows = await buildComicSummaryQuery({
    currentPath,
    cursor: decodedCursor?.subjectKind === "comic" ? decodedCursor : null,
    limit,
    query,
    randomSeed,
    showImages,
    showVideos,
    sortMode,
  });

  const hasMore = summaryRows.length > limit;
  const pageRows = hasMore ? summaryRows.slice(0, limit) : summaryRows;
  const folderPaths = pageRows.map((row) => row.folderPath);

  const coverRows =
    folderPaths.length > 0
      ? await buildComicCoverQuery({ currentPath, folderPaths, query, showImages, showVideos })
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
export function compareComicPages(left: LibraryMediaItem, right: LibraryMediaItem): number {
  return (
    compareByName(left, right) ||
    compareBytewise(left.name, right.name) ||
    compareBytewise(left.id, right.id)
  );
}

function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when `comicId` names a folder strictly inside the browse scope. */
export function isComicInBrowseScope(comicId: string, currentPath: string): boolean {
  if (!comicId || comicId === currentPath) {
    return false;
  }
  return currentPath === "" || comicId.startsWith(`${currentPath}/`);
}

/** One complete comic in natural page order, or null when it has no eligible page. */
export async function readDatabaseGalleryComic(
  request: ComicReadRequest,
): Promise<ComicEntry<LibraryMediaItem> | null> {
  if (!isComicInBrowseScope(request.comicId, request.currentPath)) {
    return null;
  }

  const rows = await buildComicPagesQuery(request);
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
