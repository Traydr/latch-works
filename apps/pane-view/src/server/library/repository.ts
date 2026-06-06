import type { FolderNode, MediaItem } from "@latch-works/media-domain";
import { getBaseName } from "@latch-works/media-domain";
import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects, thumbnails } from "../db/schema";
import { buildGalleryThumbnailUrl } from "../media/cdn-delivery";
import { escapeLikePattern, resolveMediaScope } from "./query-helpers";

export interface LibraryMediaItem extends MediaItem {
  thumbnailUrl?: string;
}

export interface DatabaseLibrarySnapshot {
  allFolders: FolderNode[];
  folders: FolderNode[];
  media: LibraryMediaItem[];
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
  limit?: number;
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
        thumbnail: thumbnails,
      })
      .from(libraryEntries)
      .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
      .leftJoin(
        thumbnails,
        and(
          eq(thumbnails.mediaObjectId, mediaObjects.id),
          eq(thumbnails.size, 320),
          eq(thumbnails.status, "ready"),
        ),
      )
      .where(and(...mediaConditions))
      .limit(limit ?? 5000)
      .offset(offset),
    db.select().from(folders).where(eq(folders.parentPath, "")),
  ] as const;

  const [folderRows, mediaRows, rootRows, allFolderRows] = await Promise.all([
    ...folderQueries,
    includeAllFolders
      ? db.select().from(folders).where(isNull(folders.deletedAt))
      : Promise.resolve([]),
  ]);

  const mapFolderRow = (folder: (typeof allFolderRows)[number]): FolderNode => ({
    folderCount: folder.folderCount ?? 0,
    hasChildren: folder.entryCount > 0 || (folder.folderCount ?? 0) > 0,
    mediaCount: folder.entryCount ?? 0,
    name: folder.name,
    parentId: folder.parentId,
    parentPath: folder.parentPath,
    path: folder.path,
  });

  return {
    allFolders: allFolderRows.map(mapFolderRow),
    folders: folderRows.map(mapFolderRow),
    media: mediaRows.map(({ entry, object, thumbnail }) => {
      const media: LibraryMediaItem = {
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

      media.thumbnailUrl = buildGalleryThumbnailUrl({
        entryId: entry.id,
        mediaType: object.mediaType,
        objectKey: thumbnail?.objectKey,
      });

      return media;
    }),
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

function dedupe(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}
