import type { FolderNode, GallerySortMode } from "@latch-works/media-domain";
import { buildBrowserEntries, getParentPath } from "@latch-works/media-domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
import { type KeysetColumn, keysetAfter, keysetOrderBy } from "./keyset-order";
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
    cursor: MediaCursor | null;
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

  const order = galleryListingOrder(sortMode, randomSeed);

  if (cursor) {
    mediaConditions.push(keysetAfter(order, cursor));
  }

  return database
    .select({
      entry: libraryEntries,
      object: mediaObjects,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...mediaConditions))
    .orderBy(...keysetOrderBy(order))
    .limit(limit + 1);
}

type MediaCursor = Extract<GalleryListingCursorPayload, { subjectKind: "media" }>;

/**
 * The listing order for regular media (Plan 051, Decision 6). Name modes use
 * the natural collation so "2.jpg" precedes "10.jpg" and case is ignored,
 * matching the client's compareByName; date modes tie-break by logical path;
 * random uses the shared seeded key over ("media", id). Every mode ends on
 * the id so the keyset is total.
 */
function galleryListingOrder(
  sortMode: GallerySortMode,
  randomSeed: GalleryRandomSeed,
): KeysetColumn<MediaCursor>[] {
  const id = (direction: "asc" | "desc"): KeysetColumn<MediaCursor> => ({
    cursorValue: (cursor) => cursor.id,
    direction,
    expression: libraryEntries.id,
  });

  const naturalName = (direction: "asc" | "desc"): KeysetColumn<MediaCursor>[] => [
    {
      cursorValue: (cursor) => cursor.filename,
      direction,
      expression: naturalOrder(libraryEntries.filename),
    },
    {
      cursorValue: (cursor) => cursor.logicalPath,
      direction,
      expression: naturalOrder(libraryEntries.logicalPath),
    },
    id(direction),
  ];

  const logicalPath: KeysetColumn<MediaCursor> = {
    cursorValue: (cursor) => cursor.logicalPath,
    direction: "asc",
    expression: libraryEntries.logicalPath,
  };

  switch (sortMode) {
    case "name-desc":
      return naturalName("desc");
    case "date-newest":
    case "date-oldest":
      return [
        {
          cursorValue: (cursor) => cursor.mtimeMs,
          direction: sortMode === "date-newest" ? "desc" : "asc",
          expression: libraryEntries.mtimeMs,
        },
        logicalPath,
        id("asc"),
      ];
    case "random":
      return [
        {
          cursorValue: cursorRandomKey,
          direction: "asc",
          expression: galleryRandomOrderKeySql(randomSeed, "media", libraryEntries.id),
        },
        logicalPath,
        id("asc"),
      ];
    default:
      return naturalName("asc");
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
