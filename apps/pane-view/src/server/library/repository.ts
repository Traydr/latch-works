import type { FolderNode, MediaItem } from "@latch-works/media-domain";
import { getBaseName } from "@latch-works/media-domain";
import { and, eq, isNull } from "drizzle-orm";
import { createPaneViewDb, readDatabaseUrl } from "../db/client";
import { folders, libraryEntries, mediaObjects } from "../db/schema";

export interface DatabaseLibrarySnapshot {
  folders: FolderNode[];
  media: MediaItem[];
  roots: string[];
}

export async function readDatabaseLibrarySnapshot({
  currentPath,
  env,
}: {
  currentPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<DatabaseLibrarySnapshot | null> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  const db = createPaneViewDb(databaseUrl);

  const [folderRows, mediaRows, rootRows] = await Promise.all([
    db.select().from(folders).where(eq(folders.parentPath, currentPath)),
    db
      .select({
        entry: libraryEntries,
        object: mediaObjects,
      })
      .from(libraryEntries)
      .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
      .where(and(eq(libraryEntries.parentPath, currentPath), isNull(libraryEntries.deletedAt))),
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
    media: mediaRows.map(({ entry, object }) => ({
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
    })),
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
