import type { FolderNode, MediaItem } from "@latch-works/media-domain";
import { getBaseName } from "@latch-works/media-domain";
import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { createPaneViewDb, readDatabaseUrl } from "../db/client";
import { folders, libraryEntries, mediaObjects, thumbnails } from "../db/schema";

export interface LibraryMediaItem extends MediaItem {
  thumbnailUrl?: string;
}

export interface DatabaseLibrarySnapshot {
  folders: FolderNode[];
  media: LibraryMediaItem[];
  roots: string[];
}

export async function readDatabaseLibrarySnapshot({
  currentPath,
  env,
  query,
}: {
  currentPath: string;
  env: NodeJS.ProcessEnv;
  query?: string;
}): Promise<DatabaseLibrarySnapshot | null> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  const db = createPaneViewDb(databaseUrl);
  const trimmedQuery = query?.trim();
  const mediaConditions: SQL[] = [isNull(libraryEntries.deletedAt)];
  const folderConditions: SQL[] = [eq(folders.parentPath, currentPath)];

  if (currentPath) {
    mediaConditions.push(ilike(libraryEntries.logicalPath, `${escapeLikePattern(currentPath)}/%`));
  }

  if (trimmedQuery) {
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
  }

  const [folderRows, mediaRows, rootRows] = await Promise.all([
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
      .where(and(...mediaConditions)),
    db.select().from(folders).where(eq(folders.parentPath, "")),
  ]);

  return {
    folders: folderRows.map((folder) => ({
      folderCount: 0,
      hasChildren: folder.entryCount > 0,
      mediaCount: folder.entryCount,
      name: folder.name,
      parentPath: folder.parentPath,
      path: folder.path,
    })),
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

      if (thumbnail) {
        media.thumbnailUrl = `/api/media/${entry.id}/thumbnail?size=${thumbnail.size}`;
      }

      return media;
    }),
    roots: rootRows
      .map((folder) => folder.path)
      .concat(currentPath)
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
