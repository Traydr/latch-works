import type { FolderNode, GallerySortMode } from "@latch-works/media-domain";
import { getParentPath } from "@latch-works/media-domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type {
  GalleryBrowseEntry,
  GalleryListingPage,
  GalleryListingRequest,
  GalleryRandomSeed,
  LibrarySnapshot,
  LibrarySnapshotRequest,
  SnapshotFolder,
} from "@/features/library/listing-contract";
import { type Database, db } from "../db";
import { guardLibraryChange } from "../db/library-guards";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import {
  cursorRandomKey,
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  type GalleryListingCursorPayload,
} from "./gallery-listing";
import { galleryRandomOrderKey, galleryRandomOrderKeySql, naturalOrder } from "./gallery-order";
import { type KeysetColumn, keysetAfter, keysetOrderBy } from "./keyset-order";
import {
  buildLibraryConditions,
  buildMediaVisibilityConditions,
  mapMediaRows,
} from "./library-conditions";

/** Most folders one search returns. */
const FOLDER_SEARCH_LIMIT = 200;

/**
 * Visible folders for the current scope: direct children, or search matches
 * capped to the first FOLDER_SEARCH_LIMIT in natural name order.
 */
function buildLibraryFolderQuery(
  { currentPath, query }: { currentPath: string; query: string | undefined },
  database: Database,
) {
  const { folderConditions, searching } = buildLibraryConditions({
    currentPath,
    query,
    recursive: false,
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
  request: GalleryListingRequest,
  cursor: MediaCursor | null,
  database: Database,
) {
  const { excludedPaths, limit, path, query, randomSeed, recursive, showImages, showVideos } =
    request;

  const { mediaConditions } = buildLibraryConditions({
    currentPath: path,
    excludedPaths,
    query,
    recursive,
  });

  mediaConditions.push(...buildMediaVisibilityConditions({ showImages, showVideos }));

  const order = galleryListingOrder(request.sortMode, randomSeed);

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

export async function readDatabaseLibrarySnapshot(
  { includeAllFolders, path, query }: LibrarySnapshotRequest,
  database: Database = db,
): Promise<LibrarySnapshot> {
  const [folderRows, allFolderRows, siblingRows] = await Promise.all([
    buildLibraryFolderQuery({ currentPath: path, query }, database),
    includeAllFolders
      ? database.select().from(folders).where(isNull(folders.deletedAt))
      : Promise.resolve([]),
    path
      ? database
          .select()
          .from(folders)
          .where(and(isNull(folders.deletedAt), eq(folders.parentPath, getParentPath(path))))
      : Promise.resolve([]),
  ]);

  // Here "has children" means child folders: the folder picker expands folders only.
  const parentPathsWithChildFolders = new Set(allFolderRows.map((folder) => folder.parentPath));

  return {
    allFolders: allFolderRows.map((folder) => mapFolderRow(folder, parentPathsWithChildFolders)),
    currentPath: path,
    folders: folderRows.map(mapSnapshotFolderRow),
    siblings: siblingRows.map(mapSnapshotFolderRow),
  };
}

/** Folder cards in display order: natural name order, reversed for name-desc. */
function folderEntries(
  folderNodes: readonly FolderNode[],
  sortMode: GallerySortMode,
): GalleryBrowseEntry[] {
  const sorted = [...folderNodes].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
  );

  if (sortMode === "name-desc") {
    sorted.reverse();
  }

  return sorted.map((folder) => ({
    hasChildren: folder.hasChildren,
    key: `folder:${folder.path}`,
    kind: "folder",
    name: folder.name,
    path: folder.path,
  }));
}

export async function readDatabaseGalleryListing(
  request: GalleryListingRequest,
  cursor: string | undefined,
  database: Database = db,
): Promise<GalleryListingPage> {
  const { limit, path, query, randomSeed, recursive, sortMode } = request;

  const decodedCursor = decodeGalleryListingCursor(cursor, {
    randomSeed,
    sortMode,
    subjectKind: "media",
  });

  const includeFolders = !recursive && !decodedCursor;

  const [folderRows, mediaRows] = await Promise.all([
    includeFolders
      ? buildLibraryFolderQuery({ currentPath: path, query }, database)
      : Promise.resolve([]),
    buildGalleryListingMediaQuery(
      request,
      decodedCursor?.subjectKind === "media" ? decodedCursor : null,
      database,
    ),
  ]);

  const hasMore = mediaRows.length > limit;
  const pageMediaRows = hasMore ? mediaRows.slice(0, limit) : mediaRows;

  // A folder card "has children" when anything lives beneath it, folders or entries.
  const visibleParentPathsWithChildren = includeFolders
    ? await readParentPathsWithChildren(
        [...new Set(folderRows.map((folder) => folder.path))],
        database,
      )
    : new Set<string>();

  const entries: GalleryBrowseEntry[] = [
    ...folderEntries(
      folderRows.map((folder) => mapFolderRow(folder, visibleParentPathsWithChildren)),
      sortMode,
    ),
    ...mapMediaRows(pageMediaRows).map(
      (media): GalleryBrowseEntry => ({ key: `media:${media.id}`, kind: "media", media }),
    ),
  ];

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
    entries,
    page: { cursor: nextCursor, hasMore, limit },
    subjectKind: "media",
  };
}

/** Soft-delete one entry, behind the same guard as a folder delete. */
export async function softDeleteLibraryEntry(
  { entryId }: { entryId: string },
  database: Database = db,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    await guardLibraryChange(tx);

    const [deleted] = await tx
      .update(libraryEntries)
      .set({ deletedAt: new Date() })
      .where(and(eq(libraryEntries.id, entryId), isNull(libraryEntries.deletedAt)))
      .returning({ id: libraryEntries.id });

    return Boolean(deleted);
  });
}

type FolderRow = typeof folders.$inferSelect;

function mapFolderRow(folder: FolderRow, parentPathsWithChildren: ReadonlySet<string>): FolderNode {
  return { ...mapSnapshotFolderRow(folder), hasChildren: parentPathsWithChildren.has(folder.path) };
}

function mapSnapshotFolderRow(folder: FolderRow): SnapshotFolder {
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
