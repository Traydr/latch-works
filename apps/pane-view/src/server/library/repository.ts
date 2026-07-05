import { GALLERY_THUMBNAIL_SIZE, PREVIEW_DERIVATIVE_SIZE } from "@latch-works/media-delivery";
import type { FolderNode, GallerySortMode } from "@latch-works/media-domain";
import { buildBrowserEntries, getBaseName } from "@latch-works/media-domain";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { resolveImageDeliveryMode } from "../../env/image-delivery";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects, thumbnails } from "../db/schema";
import { buildDerivativeDeliveryUrl } from "../media/derivative-delivery-url";
import { logDerivativeEvent } from "../media/derivative-telemetry";
import { mintImageOriginalDeliveryToken } from "../media/image-delivery";
import {
  DEFAULT_GALLERY_LISTING_LIMIT,
  decodeGalleryListingCursor,
  encodeGalleryListingCursor,
  type GalleryListingPage,
  galleryListingRandomHash,
} from "./gallery-listing";
import { buildMediaPage, type MediaPage } from "./media-page";
import { escapeLikePattern, resolveMediaScope } from "./query-helpers";
import type { LibraryMediaItem } from "./types";

export type { LibraryMediaItem, MediaPage } from "./types";

export interface DatabaseLibrarySnapshot {
  allFolders: FolderNode[];
  folders: FolderNode[];
  media: LibraryMediaItem[];
  mediaPage: MediaPage;
  roots: string[];
}

export async function readDatabaseLibrarySnapshot({
  currentPath,
  includeAllFolders = false,
  limit,
  offset = 0,
  query,
  recursive = false,
}: {
  currentPath: string;
  includeAllFolders?: boolean;
  limit: number;
  offset?: number;
  query?: string;
  recursive?: boolean;
}): Promise<DatabaseLibrarySnapshot> {
  const trimmedQuery = query?.trim();
  const searching = Boolean(trimmedQuery);
  const mediaScope = resolveMediaScope({ currentPath, recursive, searching });
  const mediaConditions: SQL[] = [isNull(libraryEntries.deletedAt)];
  const folderConditions: SQL[] = [isNull(folders.deletedAt)];

  if (searching && trimmedQuery) {
    const queryPattern = `%${escapeLikePattern(trimmedQuery)}%`;
    const mediaQueryCondition = or(
      ilike(libraryEntries.logicalPath, queryPattern),
      ilike(libraryEntries.filename, queryPattern),
    );
    const folderQueryCondition = or(
      ilike(folders.path, queryPattern),
      ilike(folders.name, queryPattern),
    );

    if (mediaQueryCondition) {
      mediaConditions.push(mediaQueryCondition);
    }

    if (folderQueryCondition) {
      folderConditions.push(folderQueryCondition);
    }
  } else {
    folderConditions.push(eq(folders.parentPath, currentPath));

    if (mediaScope.mode === "subtree") {
      mediaConditions.push(
        ilike(libraryEntries.logicalPath, `${escapeLikePattern(mediaScope.pathPrefix)}/%`),
      );
    } else if (mediaScope.mode === "direct-children") {
      mediaConditions.push(eq(libraryEntries.parentPath, mediaScope.parentPath));
    }
  }

  const folderQueries = [
    db
      .select()
      .from(folders)
      .where(and(...folderConditions)),
    limit > 0
      ? db
          .select({
            entry: libraryEntries,
            object: mediaObjects,
            thumbnail: thumbnails,
          })
          .from(libraryEntries)
          .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
          .leftJoin(
            thumbnails,
            and(
              eq(thumbnails.mediaObjectId, mediaObjects.id),
              eq(thumbnails.size, GALLERY_THUMBNAIL_SIZE),
              eq(thumbnails.status, "ready"),
            ),
          )
          .where(and(...mediaConditions))
          .orderBy(asc(libraryEntries.logicalPath), asc(libraryEntries.id))
          .limit(limit + 1)
          .offset(offset)
      : Promise.resolve([]),
    db.select().from(folders).where(eq(folders.parentPath, "")),
  ] as const;

  const [folderRows, mediaRows, rootRows, allFolderRows] = await Promise.all([
    ...folderQueries,
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

  const mapVisibleFolderRow = (folder: (typeof folderRows)[number]): FolderNode => ({
    folderCount: folder.folderCount ?? 0,
    hasChildren: visibleParentPathsWithChildren.has(folder.path),
    mediaCount: folder.entryCount ?? 0,
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  });

  const mapAllFolderRow = (folder: (typeof allFolderRows)[number]): FolderNode => ({
    folderCount: folder.folderCount ?? 0,
    hasChildren: folderParentPathsWithChildFolders.has(folder.path),
    mediaCount: folder.entryCount ?? 0,
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  });

  const { items: pageMediaRows, mediaPage } = buildMediaPage(mediaRows, limit, offset);

  const previewRows =
    pageMediaRows.length === 0
      ? []
      : await db
          .select({
            mediaObjectId: thumbnails.mediaObjectId,
            objectKey: thumbnails.objectKey,
          })
          .from(thumbnails)
          .where(
            and(
              inArray(
                thumbnails.mediaObjectId,
                pageMediaRows.map((row) => row.object.id),
              ),
              eq(thumbnails.size, PREVIEW_DERIVATIVE_SIZE),
              eq(thumbnails.status, "ready"),
            ),
          );

  const previewByObjectId = new Map(
    previewRows.map((row) => [row.mediaObjectId, row.objectKey] as const),
  );

  let embeddedReadyCount = 0;
  let embeddedPreviewCount = 0;
  let thumbnailEligibleCount = 0;

  const media = await Promise.all(
    pageMediaRows.map(async ({ entry, object, thumbnail }): Promise<LibraryMediaItem> => {
      const item: LibraryMediaItem = {
        durationMs: object.durationMs ?? undefined,
        extension: object.extension,
        height: object.height ?? undefined,
        id: entry.id,
        mediaType: object.mediaType,
        mtimeMs: entry.mtimeMs,
        name: entry.filename,
        pageCount: object.pageCount ?? undefined,
        parentPath: entry.parentPath,
        path: entry.logicalPath,
        sha256: object.sha256,
        size: object.size,
        width: object.width ?? undefined,
      };

      if (supportsGalleryThumbnail(object.mediaType)) {
        thumbnailEligibleCount += 1;

        // Hybrid image delivery: embed ready derivatives when available, otherwise
        // mint a Bunny Original token for on-the-fly transforms.
        if (
          (object.mediaType === "image" || object.mediaType === "gif") &&
          resolveImageDeliveryMode() === "bunny"
        ) {
          if (thumbnail) {
            item.thumbnailUrl = await buildDerivativeDeliveryUrl(thumbnail.objectKey);
            embeddedReadyCount += 1;
          } else {
            item.thumbnailDeliveryToken = mintImageOriginalDeliveryToken({
              extension: object.extension,
              mediaObjectId: object.id,
              mediaType: object.mediaType,
              originalObjectKey: object.objectKey,
              sha256: object.sha256,
            });
            embeddedReadyCount += 1;
          }
        } else if (thumbnail) {
          item.thumbnailUrl = await buildDerivativeDeliveryUrl(thumbnail.objectKey);
          embeddedReadyCount += 1;
        }

        const previewObjectKey = previewByObjectId.get(object.id);
        if (previewObjectKey) {
          item.previewUrl = await buildDerivativeDeliveryUrl(previewObjectKey);
          embeddedPreviewCount += 1;
        }
      }

      return item;
    }),
  );

  logDerivativeEvent("library.snapshot.thumbnail_embed", {
    embeddedPreview: embeddedPreviewCount,
    embeddedReady: embeddedReadyCount,
    pageSize: media.length,
    pendingFallback: thumbnailEligibleCount - embeddedReadyCount,
    thumbnailEligible: thumbnailEligibleCount,
  });

  return {
    allFolders: allFolderRows.map(mapAllFolderRow),
    folders: folderRows.map(mapVisibleFolderRow),
    media,
    mediaPage,
    roots: rootRows
      .map((folder) => folder.path)
      .concat(currentPath)
      .filter(Boolean)
      .filter(dedupe),
  };
}

export function folderFromPath(path: string): FolderNode {
  return {
    folderCount: 0,
    hasChildren: false,
    mediaCount: 0,
    name: getBaseName(path),
    parentPath: "",
    path,
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
}: {
  currentPath: string;
  cursor?: string;
  limit?: number;
  query?: string;
  randomSeed: number;
  recursive?: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}): Promise<GalleryListingPage> {
  const trimmedQuery = query?.trim();
  const searching = Boolean(trimmedQuery);
  const decodedCursor = decodeGalleryListingCursor(cursor);
  const includeFolders = !recursive && !cursor;
  const mediaScope = resolveMediaScope({ currentPath, recursive, searching });
  const mediaConditions: SQL[] = [isNull(libraryEntries.deletedAt)];
  const folderConditions: SQL[] = [isNull(folders.deletedAt)];

  if (searching && trimmedQuery) {
    const queryPattern = `%${escapeLikePattern(trimmedQuery)}%`;
    const mediaQueryCondition = or(
      ilike(libraryEntries.logicalPath, queryPattern),
      ilike(libraryEntries.filename, queryPattern),
    );
    const folderQueryCondition = or(
      ilike(folders.path, queryPattern),
      ilike(folders.name, queryPattern),
    );

    if (mediaQueryCondition) {
      mediaConditions.push(mediaQueryCondition);
    }

    if (folderQueryCondition) {
      folderConditions.push(folderQueryCondition);
    }
  } else {
    folderConditions.push(eq(folders.parentPath, currentPath));

    if (mediaScope.mode === "subtree") {
      mediaConditions.push(
        ilike(libraryEntries.logicalPath, `${escapeLikePattern(mediaScope.pathPrefix)}/%`),
      );
    } else if (mediaScope.mode === "direct-children") {
      mediaConditions.push(eq(libraryEntries.parentPath, mediaScope.parentPath));
    }
  }

  if (!showImages) {
    mediaConditions.push(notInArray(mediaObjects.mediaType, ["image", "gif"]));
  }

  if (!showVideos) {
    mediaConditions.push(ne(mediaObjects.mediaType, "video"));
  }

  if (decodedCursor) {
    mediaConditions.push(buildGalleryListingCursorCondition(decodedCursor));
  }

  const [folderRows, mediaRows] = await Promise.all([
    includeFolders
      ? db
          .select()
          .from(folders)
          .where(and(...folderConditions))
      : Promise.resolve([]),
    db
      .select({
        entry: libraryEntries,
        object: mediaObjects,
        thumbnail: thumbnails,
      })
      .from(libraryEntries)
      .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
      .leftJoin(
        thumbnails,
        and(
          eq(thumbnails.mediaObjectId, mediaObjects.id),
          eq(thumbnails.size, GALLERY_THUMBNAIL_SIZE),
          eq(thumbnails.status, "ready"),
        ),
      )
      .where(and(...mediaConditions))
      .orderBy(...buildGalleryListingOrderBy(sortMode, randomSeed))
      .limit(limit + 1),
  ]);

  const hasMore = mediaRows.length > limit;
  const pageMediaRows = hasMore ? mediaRows.slice(0, limit) : mediaRows;

  const visibleFolderPaths = [...new Set(folderRows.map((folder) => folder.path))];
  const visibleParentPathsWithChildren = includeFolders
    ? await readParentPathsWithChildren(visibleFolderPaths)
    : new Set<string>();

  const folderNodes: FolderNode[] = folderRows.map((folder) => ({
    folderCount: folder.folderCount ?? 0,
    hasChildren: visibleParentPathsWithChildren.has(folder.path),
    mediaCount: folder.entryCount ?? 0,
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  }));

  const previewRows =
    pageMediaRows.length === 0
      ? []
      : await db
          .select({
            mediaObjectId: thumbnails.mediaObjectId,
            objectKey: thumbnails.objectKey,
          })
          .from(thumbnails)
          .where(
            and(
              inArray(
                thumbnails.mediaObjectId,
                pageMediaRows.map((row) => row.object.id),
              ),
              eq(thumbnails.size, PREVIEW_DERIVATIVE_SIZE),
              eq(thumbnails.status, "ready"),
            ),
          );

  const previewByObjectId = new Map(
    previewRows.map((row) => [row.mediaObjectId, row.objectKey] as const),
  );

  const media = await mapMediaRowsToLibraryItems(pageMediaRows, previewByObjectId);
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

function supportsGalleryThumbnail(mediaType: string): boolean {
  return mediaType === "image" || mediaType === "gif" || mediaType === "video";
}

function buildGalleryListingOrderBy(sortMode: GallerySortMode, randomSeed: number) {
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

function buildGalleryListingCursorCondition(
  cursor: NonNullable<ReturnType<typeof decodeGalleryListingCursor>>,
): SQL {
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

type MediaRow = {
  entry: typeof libraryEntries.$inferSelect;
  object: typeof mediaObjects.$inferSelect;
  thumbnail: typeof thumbnails.$inferSelect | null;
};

async function mapMediaRowsToLibraryItems(
  pageMediaRows: MediaRow[],
  previewByObjectId: Map<string, string>,
): Promise<LibraryMediaItem[]> {
  return Promise.all(
    pageMediaRows.map(async ({ entry, object, thumbnail }): Promise<LibraryMediaItem> => {
      const item: LibraryMediaItem = {
        durationMs: object.durationMs ?? undefined,
        extension: object.extension,
        height: object.height ?? undefined,
        id: entry.id,
        mediaType: object.mediaType,
        mtimeMs: entry.mtimeMs,
        name: entry.filename,
        pageCount: object.pageCount ?? undefined,
        parentPath: entry.parentPath,
        path: entry.logicalPath,
        sha256: object.sha256,
        size: object.size,
        width: object.width ?? undefined,
      };

      if (supportsGalleryThumbnail(object.mediaType)) {
        if (
          (object.mediaType === "image" || object.mediaType === "gif") &&
          resolveImageDeliveryMode() === "bunny"
        ) {
          if (thumbnail) {
            item.thumbnailUrl = await buildDerivativeDeliveryUrl(thumbnail.objectKey);
          } else {
            item.thumbnailDeliveryToken = mintImageOriginalDeliveryToken({
              extension: object.extension,
              mediaObjectId: object.id,
              mediaType: object.mediaType,
              originalObjectKey: object.objectKey,
              sha256: object.sha256,
            });
          }
        } else if (thumbnail) {
          item.thumbnailUrl = await buildDerivativeDeliveryUrl(thumbnail.objectKey);
        }

        const previewObjectKey = previewByObjectId.get(object.id);
        if (previewObjectKey) {
          item.previewUrl = await buildDerivativeDeliveryUrl(previewObjectKey);
        }
      }

      return item;
    }),
  );
}
