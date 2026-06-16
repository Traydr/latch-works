import { GALLERY_THUMBNAIL_SIZE, PREVIEW_DERIVATIVE_SIZE } from "@latch-works/media-delivery";
import type { FolderNode } from "@latch-works/media-domain";
import { getBaseName } from "@latch-works/media-domain";
import { and, asc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects, thumbnails } from "../db/schema";
import { buildDerivativeDeliveryUrl } from "../media/derivative-delivery-url";
import { logDerivativeEvent } from "../media/derivative-telemetry";
import { buildMediaPage, type MediaPage } from "./media-page";
import { escapeLikePattern, resolveMediaScope } from "./query-helpers";
import type { LibraryMediaItem } from "./types";

const previewThumbnails = alias(thumbnails, "preview_thumbnails");

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
    db
      .select({
        entry: libraryEntries,
        object: mediaObjects,
        preview: previewThumbnails,
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
      .leftJoin(
        previewThumbnails,
        and(
          eq(previewThumbnails.mediaObjectId, mediaObjects.id),
          eq(previewThumbnails.size, PREVIEW_DERIVATIVE_SIZE),
          eq(previewThumbnails.status, "ready"),
        ),
      )
      .where(and(...mediaConditions))
      .orderBy(asc(libraryEntries.logicalPath), asc(libraryEntries.id))
      .limit(limit + 1)
      .offset(offset),
    db.select().from(folders).where(eq(folders.parentPath, "")),
  ] as const;

  const [folderRows, mediaRows, rootRows, allFolderRows] = await Promise.all([
    ...folderQueries,
    includeAllFolders
      ? db.select().from(folders).where(isNull(folders.deletedAt))
      : Promise.resolve([]),
  ]);

  const folderPaths = [...new Set([...folderRows, ...allFolderRows].map((folder) => folder.path))];
  const parentPathsWithChildren = await readParentPathsWithChildren(folderPaths);

  const mapFolderRow = (folder: (typeof allFolderRows)[number]): FolderNode => ({
    folderCount: folder.folderCount ?? 0,
    hasChildren: parentPathsWithChildren.has(folder.path),
    mediaCount: folder.entryCount ?? 0,
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  });

  const { items: pageMediaRows, mediaPage } = buildMediaPage(mediaRows, limit, offset);

  let embeddedReadyCount = 0;
  let embeddedPreviewCount = 0;
  let thumbnailEligibleCount = 0;

  const media = await Promise.all(
    pageMediaRows.map(async ({ entry, object, preview, thumbnail }): Promise<LibraryMediaItem> => {
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

        // When the gallery-size derivative is already `ready`, embed its real
        // delivery URL so the client renders directly without a per-tile
        // `resolveMediaDeliveryUrl` server-function round-trip. Missing/pending
        // derivatives leave `thumbnailUrl` undefined and fall back to polling.
        if (thumbnail) {
          item.thumbnailUrl = await buildDerivativeDeliveryUrl(thumbnail.objectKey);
          embeddedReadyCount += 1;
        }

        if (preview) {
          item.previewUrl = await buildDerivativeDeliveryUrl(preview.objectKey);
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
    allFolders: allFolderRows.map(mapFolderRow),
    folders: folderRows.map(mapFolderRow),
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
