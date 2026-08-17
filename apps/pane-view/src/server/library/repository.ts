import type { FolderNode, GallerySortMode } from "@latch-works/media-domain";
import { buildBrowserEntries } from "@latch-works/media-domain";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import {
  DEFAULT_GALLERY_LISTING_LIMIT,
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  type GalleryListingCursorPayload,
  type GalleryListingPage,
  galleryListingRandomHash,
} from "./gallery-listing";
import {
  buildLibraryConditions,
  buildMediaVisibilityConditions,
  mapMediaRowsToLibraryItems,
} from "./library-conditions";
import type { LibraryMediaItem, MediaPage } from "./types";

export type { LibraryMediaItem, MediaPage } from "./types";

export interface DatabaseLibrarySnapshot {
  allFolders: FolderNode[];
  folders: FolderNode[];
  media: LibraryMediaItem[];
  mediaPage: MediaPage;
  roots: string[];
}

export interface LibrarySnapshotReadRequest {
  currentPath: string;
  includeAllFolders?: boolean;
  limit: number;
  offset?: number;
  query?: string;
  recursive?: boolean;
}

export interface GalleryListingReadRequest {
  currentPath: string;
  cursor?: string;
  limit?: number;
  query?: string;
  randomSeed: number;
  recursive?: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

// ---------------------------------------------------------------------------
// Query builders. Exported for the rendered-SQL tests only; every other module
// goes through the readDatabase* functions below.
// ---------------------------------------------------------------------------

/** Snapshot media page: logical-path order, offset paginated, overfetched by one. */
export function buildLibrarySnapshotMediaQuery({
  currentPath,
  limit,
  offset = 0,
  query,
  recursive = false,
}: Pick<LibrarySnapshotReadRequest, "currentPath" | "limit" | "offset" | "query" | "recursive">) {
  const { mediaConditions } = buildLibraryConditions({ currentPath, query, recursive });

  return db
    .select({
      entry: libraryEntries,
      object: mediaObjects,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(...mediaConditions))
    .orderBy(asc(libraryEntries.logicalPath), asc(libraryEntries.id))
    .limit(limit + 1)
    .offset(offset);
}

/** Visible folders for the current scope (direct children, or search matches). */
export function buildLibraryFolderQuery({
  currentPath,
  query,
  recursive = false,
}: Pick<LibrarySnapshotReadRequest, "currentPath" | "query" | "recursive">) {
  const { folderConditions } = buildLibraryConditions({ currentPath, query, recursive });

  return db
    .select()
    .from(folders)
    .where(and(...folderConditions));
}

/** Listing media page: sorted, filtered, keyset-continued, overfetched by one. */
export function buildGalleryListingMediaQuery({
  currentPath,
  cursor,
  limit = DEFAULT_GALLERY_LISTING_LIMIT,
  query,
  randomSeed,
  recursive = false,
  showImages,
  showVideos,
  sortMode,
}: Omit<GalleryListingReadRequest, "cursor"> & { cursor: GalleryListingCursorPayload | null }) {
  const { mediaConditions } = buildLibraryConditions({ currentPath, query, recursive });
  mediaConditions.push(...buildMediaVisibilityConditions({ showImages, showVideos }));

  if (cursor) {
    mediaConditions.push(buildGalleryListingCursorCondition(cursor));
  }

  return db
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

export function buildGalleryListingOrderBy(sortMode: GallerySortMode, randomSeed: number): SQL[] {
  switch (sortMode) {
    case "name-desc":
      return [
        desc(libraryEntries.filename),
        desc(libraryEntries.logicalPath),
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
        asc(sql`md5(concat(${randomSeed}::text, ':', ${libraryEntries.id}::text))`),
        asc(libraryEntries.logicalPath),
        asc(libraryEntries.id),
      ];
    default:
      return [
        asc(libraryEntries.filename),
        asc(libraryEntries.logicalPath),
        asc(libraryEntries.id),
      ];
  }
}

export function buildGalleryListingCursorCondition(cursor: GalleryListingCursorPayload): SQL {
  const requireCondition = (condition: SQL | undefined): SQL => {
    if (!condition) {
      throw new Error("Expected gallery listing cursor condition");
    }
    return condition;
  };

  switch (cursor.sortMode) {
    case "name-desc":
      return requireCondition(
        or(
          lt(libraryEntries.filename, cursor.filename),
          and(
            eq(libraryEntries.filename, cursor.filename),
            lt(libraryEntries.logicalPath, cursor.logicalPath),
          ),
          and(
            eq(libraryEntries.filename, cursor.filename),
            eq(libraryEntries.logicalPath, cursor.logicalPath),
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
    case "random":
      return requireCondition(
        or(
          gt(
            sql`md5(concat(${cursor.randomSeed ?? 0}::text, ':', ${libraryEntries.id}::text))`,
            cursor.randomHash ?? "",
          ),
          and(
            eq(
              sql`md5(concat(${cursor.randomSeed ?? 0}::text, ':', ${libraryEntries.id}::text))`,
              cursor.randomHash ?? "",
            ),
            gt(libraryEntries.logicalPath, cursor.logicalPath),
          ),
          and(
            eq(
              sql`md5(concat(${cursor.randomSeed ?? 0}::text, ':', ${libraryEntries.id}::text))`,
              cursor.randomHash ?? "",
            ),
            eq(libraryEntries.logicalPath, cursor.logicalPath),
            gt(libraryEntries.id, cursor.id),
          ),
        ),
      );
    default:
      return requireCondition(
        or(
          gt(libraryEntries.filename, cursor.filename),
          and(
            eq(libraryEntries.filename, cursor.filename),
            gt(libraryEntries.logicalPath, cursor.logicalPath),
          ),
          and(
            eq(libraryEntries.filename, cursor.filename),
            eq(libraryEntries.logicalPath, cursor.logicalPath),
            gt(libraryEntries.id, cursor.id),
          ),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readDatabaseLibrarySnapshot({
  currentPath,
  includeAllFolders = false,
  limit,
  offset = 0,
  query,
  recursive = false,
}: LibrarySnapshotReadRequest): Promise<DatabaseLibrarySnapshot> {
  const [folderRows, mediaRows, rootRows, allFolderRows] = await Promise.all([
    buildLibraryFolderQuery({ currentPath, query, recursive }),
    limit > 0
      ? buildLibrarySnapshotMediaQuery({ currentPath, limit, offset, query, recursive })
      : Promise.resolve([]),
    db.select().from(folders).where(eq(folders.parentPath, "")),
    includeAllFolders
      ? db.select().from(folders).where(isNull(folders.deletedAt))
      : Promise.resolve([]),
  ]);

  const visibleFolderPaths = [...new Set(folderRows.map((folder) => folder.path))];
  const visibleParentPathsWithChildren = await readParentPathsWithChildren(visibleFolderPaths);
  const folderParentPathsWithChildFolders = new Set(
    allFolderRows
      .map((folder) => folder.parentPath)
      .filter((parentPath): parentPath is string => Boolean(parentPath)),
  );

  const { items: pageMediaRows, mediaPage } = buildMediaPage(mediaRows, limit, offset);

  return {
    allFolders: allFolderRows.map((folder) =>
      mapFolderRow(folder, folderParentPathsWithChildFolders),
    ),
    folders: folderRows.map((folder) => mapFolderRow(folder, visibleParentPathsWithChildren)),
    media: mapMediaRowsToLibraryItems(pageMediaRows),
    mediaPage,
    roots: rootRows
      .map((folder) => folder.path)
      .concat(currentPath)
      .filter(Boolean)
      .filter(dedupe),
  };
}

export async function readDatabaseGalleryListing({
  currentPath,
  cursor,
  limit = DEFAULT_GALLERY_LISTING_LIMIT,
  query,
  randomSeed,
  recursive = false,
  showImages,
  showVideos,
  sortMode,
}: GalleryListingReadRequest): Promise<GalleryListingPage> {
  const decodedCursor = decodeGalleryListingCursor(cursor);
  const includeFolders = !recursive && !cursor;

  const [folderRows, mediaRows] = await Promise.all([
    includeFolders
      ? buildLibraryFolderQuery({ currentPath, query, recursive })
      : Promise.resolve([]),
    buildGalleryListingMediaQuery({
      currentPath,
      cursor: decodedCursor,
      limit,
      query,
      randomSeed,
      recursive,
      showImages,
      showVideos,
      sortMode,
    }),
  ]);

  const hasMore = mediaRows.length > limit;
  const pageMediaRows = hasMore ? mediaRows.slice(0, limit) : mediaRows;

  const visibleFolderPaths = [...new Set(folderRows.map((folder) => folder.path))];
  const visibleParentPathsWithChildren = includeFolders
    ? await readParentPathsWithChildren(visibleFolderPaths)
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
          randomHash:
            sortMode === "random"
              ? galleryListingRandomHash(randomSeed, lastRow.entry.id)
              : undefined,
          randomSeed: sortMode === "random" ? randomSeed : undefined,
          sortMode,
        })
      : null;

  return {
    entries,
    media,
    page: {
      cursor: nextCursor,
      hasMore,
      limit,
    },
  };
}

export async function softDeleteLibraryEntry({ entryId }: { entryId: string }): Promise<boolean> {
  const [deleted] = await db
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
  return {
    folderCount: folder.folderCount ?? 0,
    hasChildren: parentPathsWithChildren.has(folder.path),
    mediaCount: folder.entryCount ?? 0,
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  };
}

/** Slice an overfetched (limit + 1) row set into a page plus offset metadata. */
export function buildMediaPage<T>(
  rows: readonly T[],
  limit: number,
  offset: number,
): {
  items: T[];
  mediaPage: MediaPage;
} {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : [...rows],
    mediaPage: {
      hasMore,
      limit,
      nextOffset: hasMore ? offset + limit : null,
      offset,
    },
  };
}

const parentPathLookupThreshold = 500;

async function readParentPathsWithChildren(paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }

  const pathSet = new Set(paths);
  const [folderParents, entryParents] =
    paths.length > parentPathLookupThreshold
      ? await Promise.all([
          db
            .selectDistinct({ parentPath: folders.parentPath })
            .from(folders)
            .where(isNull(folders.deletedAt)),
          db
            .selectDistinct({ parentPath: libraryEntries.parentPath })
            .from(libraryEntries)
            .where(isNull(libraryEntries.deletedAt)),
        ])
      : await Promise.all([
          db
            .selectDistinct({ parentPath: folders.parentPath })
            .from(folders)
            .where(and(isNull(folders.deletedAt), inArray(folders.parentPath, paths))),
          db
            .selectDistinct({ parentPath: libraryEntries.parentPath })
            .from(libraryEntries)
            .where(
              and(isNull(libraryEntries.deletedAt), inArray(libraryEntries.parentPath, paths)),
            ),
        ]);

  const parents = new Set<string>();
  for (const row of [...folderParents, ...entryParents]) {
    if (row.parentPath && pathSet.has(row.parentPath)) {
      parents.add(row.parentPath);
    }
  }

  return parents;
}

function dedupe(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}
