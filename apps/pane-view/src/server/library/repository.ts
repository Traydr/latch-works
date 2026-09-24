import type { FolderNode, GallerySortMode } from "@latch-works/media-domain";
import { buildBrowserEntries, getParentPath } from "@latch-works/media-domain";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { type Database, db } from "../db";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import {
  cursorRandomKey,
  DEFAULT_GALLERY_LISTING_LIMIT,
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  type GalleryListingCursorPayload,
  type GalleryListingPage,
} from "./gallery-listing";
import {
  type GalleryRandomSeed,
  galleryRandomOrderKey,
  galleryRandomOrderKeySql,
  naturalOrder,
} from "./gallery-order";
import {
  buildLibraryConditions,
  buildMediaVisibilityConditions,
  mapMediaRowsToLibraryItems,
} from "./library-conditions";

/**
 * A snapshot's `folders` and `siblings` feed the sidebar, the exclude dialog,
 * and sibling navigation, none of which shows whether a folder has children,
 * so the snapshot skips that lookup.
 */
export type SnapshotFolderNode = Omit<FolderNode, "hasChildren">;

export interface DatabaseLibrarySnapshot {
  allFolders: FolderNode[];
  folders: SnapshotFolderNode[];
  /**
   * Non-deleted folders that share `currentPath`'s parent, `currentPath`
   * itself included; empty at the root. Unordered: callers sort. Feeds
   * previous/next sibling navigation, which `folders` (the children) cannot.
   */
  siblings: SnapshotFolderNode[];
}

export interface LibrarySnapshotReadRequest {
  currentPath: string;
  includeAllFolders?: boolean;
  query?: string;
  recursive?: boolean;
}

export interface GalleryListingReadRequest {
  currentPath: string;
  cursor?: string;
  /** Direct-child subtrees to subtract in recursive mode (Plan 054). */
  excludedPaths?: readonly string[];
  limit?: number;
  query?: string;
  randomSeed: GalleryRandomSeed;
  recursive?: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

// ---------------------------------------------------------------------------
// Query builders, used only by the readDatabase* functions below.
// ---------------------------------------------------------------------------

/** Most folders one search returns. */
const FOLDER_SEARCH_LIMIT = 200;

/**
 * Visible folders for the current scope: direct children, or search matches
 * capped to the first FOLDER_SEARCH_LIMIT in natural name order.
 */
function buildLibraryFolderQuery(
  {
    currentPath,
    query,
    recursive = false,
  }: Pick<LibrarySnapshotReadRequest, "currentPath" | "query" | "recursive">,
  database: Database = db,
) {
  const { folderConditions, searching } = buildLibraryConditions({
    currentPath,
    query,
    recursive,
  });

  const folderQuery = database
    .select()
    .from(folders)
    .where(and(...folderConditions));

  return searching
    ? folderQuery
        .orderBy(asc(naturalOrder(folders.name)), asc(folders.path))
        .limit(FOLDER_SEARCH_LIMIT)
    : folderQuery;
}

/** Listing media page: sorted, filtered, keyset-continued, overfetched by one. */
function buildGalleryListingMediaQuery(
  {
    currentPath,
    cursor,
    excludedPaths,
    limit = DEFAULT_GALLERY_LISTING_LIMIT,
    query,
    randomSeed,
    recursive = false,
    showImages,
    showVideos,
    sortMode,
  }: Omit<GalleryListingReadRequest, "cursor"> & {
    cursor: Extract<GalleryListingCursorPayload, { subjectKind: "media" }> | null;
  },
  database: Database = db,
) {
  const { mediaConditions } = buildLibraryConditions({
    currentPath,
    excludedPaths,
    query,
    recursive,
  });

  mediaConditions.push(...buildMediaVisibilityConditions({ showImages, showVideos }));

  if (cursor) {
    mediaConditions.push(buildGalleryListingCursorCondition(cursor));
  }

  return database
    .select({
      entry: libraryEntries,
      object: mediaObjects,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...mediaConditions))
    .orderBy(...buildGalleryListingOrderBy(sortMode, randomSeed))
    .limit(limit + 1);
}

/**
 * The listing order for regular media (Plan 051, Decision 6). Name modes use
 * the natural collation so "2.jpg" precedes "10.jpg" and case is ignored,
 * matching the client's compareByName; date modes tie-break by logical path;
 * random uses the shared seeded key over ("media", id). Every mode ends on
 * the id so the keyset is total.
 */
function buildGalleryListingOrderBy(
  sortMode: GallerySortMode,
  randomSeed: GalleryRandomSeed,
): SQL[] {
  switch (sortMode) {
    case "name-desc":
      return [
        desc(naturalOrder(libraryEntries.filename)),
        desc(naturalOrder(libraryEntries.logicalPath)),
        desc(libraryEntries.id),
      ];
    case "date-newest":
      return [
        desc(libraryEntries.mtimeMs),
        asc(libraryEntries.logicalPath),
        asc(libraryEntries.id),
      ];
    case "date-oldest":
      return [asc(libraryEntries.mtimeMs), asc(libraryEntries.logicalPath), asc(libraryEntries.id)];
    case "random":
      return [
        asc(galleryRandomOrderKeySql(randomSeed, "media", libraryEntries.id)),
        asc(libraryEntries.logicalPath),
        asc(libraryEntries.id),
      ];
    default:
      return [
        asc(naturalOrder(libraryEntries.filename)),
        asc(naturalOrder(libraryEntries.logicalPath)),
        asc(libraryEntries.id),
      ];
  }
}

/**
 * Keyset continuation for buildGalleryListingOrderBy: rows strictly after the
 * cursor row in that order, comparing each column with the same collation and
 * direction the ORDER BY uses.
 */
function buildGalleryListingCursorCondition(
  cursor: Extract<GalleryListingCursorPayload, { subjectKind: "media" }>,
): SQL {
  const requireCondition = (condition: SQL | undefined): SQL => {
    if (!condition) {
      throw new Error("Expected gallery listing cursor condition");
    }

    return condition;
  };

  const filename = naturalOrder(libraryEntries.filename);
  const logicalPath = naturalOrder(libraryEntries.logicalPath);

  switch (cursor.sortMode) {
    case "name-desc":
      return requireCondition(
        or(
          lt(filename, cursor.filename),
          and(eq(filename, cursor.filename), lt(logicalPath, cursor.logicalPath)),
          and(
            eq(filename, cursor.filename),
            eq(logicalPath, cursor.logicalPath),
            lt(libraryEntries.id, cursor.id),
          ),
        ),
      );
    case "date-newest":
      return requireCondition(
        or(
          lt(libraryEntries.mtimeMs, cursor.mtimeMs),
          and(
            eq(libraryEntries.mtimeMs, cursor.mtimeMs),
            gt(libraryEntries.logicalPath, cursor.logicalPath),
          ),
          and(
            eq(libraryEntries.mtimeMs, cursor.mtimeMs),
            eq(libraryEntries.logicalPath, cursor.logicalPath),
            gt(libraryEntries.id, cursor.id),
          ),
        ),
      );
    case "date-oldest":
      return requireCondition(
        or(
          gt(libraryEntries.mtimeMs, cursor.mtimeMs),
          and(
            eq(libraryEntries.mtimeMs, cursor.mtimeMs),
            gt(libraryEntries.logicalPath, cursor.logicalPath),
          ),
          and(
            eq(libraryEntries.mtimeMs, cursor.mtimeMs),
            eq(libraryEntries.logicalPath, cursor.logicalPath),
            gt(libraryEntries.id, cursor.id),
          ),
        ),
      );
    case "random": {
      const key = galleryRandomOrderKeySql(cursor.randomSeed, "media", libraryEntries.id);
      const cursorKey = cursorRandomKey(cursor);

      return requireCondition(
        or(
          gt(key, cursorKey),
          and(eq(key, cursorKey), gt(libraryEntries.logicalPath, cursor.logicalPath)),
          and(
            eq(key, cursorKey),
            eq(libraryEntries.logicalPath, cursor.logicalPath),
            gt(libraryEntries.id, cursor.id),
          ),
        ),
      );
    }

    default:
      return requireCondition(
        or(
          gt(filename, cursor.filename),
          and(eq(filename, cursor.filename), gt(logicalPath, cursor.logicalPath)),
          and(
            eq(filename, cursor.filename),
            eq(logicalPath, cursor.logicalPath),
            gt(libraryEntries.id, cursor.id),
          ),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readDatabaseLibrarySnapshot(
  { currentPath, includeAllFolders = false, query, recursive = false }: LibrarySnapshotReadRequest,
  database: Database = db,
): Promise<DatabaseLibrarySnapshot> {
  const [folderRows, allFolderRows, siblingRows] = await Promise.all([
    buildLibraryFolderQuery({ currentPath, query, recursive }, database),
    includeAllFolders
      ? database.select().from(folders).where(isNull(folders.deletedAt))
      : Promise.resolve([]),
    currentPath
      ? database
          .select()
          .from(folders)
          .where(and(isNull(folders.deletedAt), eq(folders.parentPath, getParentPath(currentPath))))
      : Promise.resolve([]),
  ]);

  const folderParentPathsWithChildFolders = new Set(
    allFolderRows
      .map((folder) => folder.parentPath)
      .filter((parentPath): parentPath is string => Boolean(parentPath)),
  );

  return {
    allFolders: allFolderRows.map((folder) =>
      mapFolderRow(folder, folderParentPathsWithChildFolders),
    ),
    folders: folderRows.map(mapSnapshotFolderRow),
    siblings: siblingRows.map(mapSnapshotFolderRow),
  };
}

export async function readDatabaseGalleryListing(
  {
    currentPath,
    cursor,
    excludedPaths,
    limit = DEFAULT_GALLERY_LISTING_LIMIT,
    query,
    randomSeed,
    recursive = false,
    showImages,
    showVideos,
    sortMode,
  }: GalleryListingReadRequest,
  database: Database = db,
): Promise<GalleryListingPage> {
  const decodedCursor = decodeGalleryListingCursor(cursor, {
    randomSeed,
    sortMode,
    subjectKind: "media",
  });

  const includeFolders = !recursive && !decodedCursor;

  const [folderRows, mediaRows] = await Promise.all([
    includeFolders
      ? buildLibraryFolderQuery({ currentPath, query, recursive }, database)
      : Promise.resolve([]),
    buildGalleryListingMediaQuery(
      {
        currentPath,
        cursor: decodedCursor?.subjectKind === "media" ? decodedCursor : null,
        excludedPaths,
        limit,
        query,
        randomSeed,
        recursive,
        showImages,
        showVideos,
        sortMode,
      },
      database,
    ),
  ]);

  const hasMore = mediaRows.length > limit;
  const pageMediaRows = hasMore ? mediaRows.slice(0, limit) : mediaRows;

  const visibleFolderPaths = [...new Set(folderRows.map((folder) => folder.path))];

  const visibleParentPathsWithChildren = includeFolders
    ? await readParentPathsWithChildren(visibleFolderPaths, database)
    : new Set<string>();

  const folderNodes = folderRows.map((folder) =>
    mapFolderRow(folder, visibleParentPathsWithChildren),
  );

  const media = mapMediaRowsToLibraryItems(pageMediaRows);

  const entries = buildBrowserEntries({
    folders: folderNodes,
    comics: [],
    items: media,
    recursive,
    comicMode: false,
    sortMode,
  });

  const lastRow = pageMediaRows.at(-1);

  const nextCursor =
    hasMore && lastRow
      ? encodeGalleryListingCursor({
          filename: lastRow.entry.filename,
          id: lastRow.entry.id,
          logicalPath: lastRow.entry.logicalPath,
          mtimeMs: lastRow.entry.mtimeMs,
          randomKey:
            sortMode === "random"
              ? galleryRandomOrderKey(randomSeed, "media", lastRow.entry.id)
              : undefined,
          randomSeed,
          sortMode,
          subjectKind: "media",
        })
      : null;

  return {
    comics: [],
    entries,
    media,
    page: {
      cursor: nextCursor,
      hasMore,
      limit,
    },
    subjectKind: "media",
  };
}

export async function softDeleteLibraryEntry(
  { entryId }: { entryId: string },
  database: Database = db,
): Promise<boolean> {
  const [deleted] = await database
    .update(libraryEntries)
    .set({ deletedAt: new Date() })
    .where(and(eq(libraryEntries.id, entryId), isNull(libraryEntries.deletedAt)))
    .returning({ id: libraryEntries.id });

  return Boolean(deleted);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FolderRow = typeof folders.$inferSelect;

function mapFolderRow(folder: FolderRow, parentPathsWithChildren: ReadonlySet<string>): FolderNode {
  return { ...mapSnapshotFolderRow(folder), hasChildren: parentPathsWithChildren.has(folder.path) };
}

function mapSnapshotFolderRow(folder: FolderRow): SnapshotFolderNode {
  return {
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  };
}

/** Most paths one `IN (…)` lookup carries; longer lists are looked up in batches, one at a time. */
const parentPathLookupBatchSize = 500;

async function readParentPathsWithChildren(
  paths: string[],
  database: Database,
): Promise<Set<string>> {
  const batches: string[][] = [];

  for (let start = 0; start < paths.length; start += parentPathLookupBatchSize) {
    batches.push(paths.slice(start, start + parentPathLookupBatchSize));
  }

  const pathSet = new Set(paths);
  const parents = new Set<string>();

  // One batch at a time, so a huge folder can't queue dozens of queries on the pool.
  for (const batch of batches) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Bounded concurrency: two queries per batch, one batch at a time.
    const rows = await Promise.all([
      database
        .selectDistinct({ parentPath: folders.parentPath })
        .from(folders)
        .where(and(isNull(folders.deletedAt), inArray(folders.parentPath, batch))),
      database
        .selectDistinct({ parentPath: libraryEntries.parentPath })
        .from(libraryEntries)
        .where(and(isNull(libraryEntries.deletedAt), inArray(libraryEntries.parentPath, batch))),
    ]);

    for (const row of rows.flat()) {
      if (row.parentPath && pathSet.has(row.parentPath)) {
        parents.add(row.parentPath);
      }
    }
  }

  return parents;
}
