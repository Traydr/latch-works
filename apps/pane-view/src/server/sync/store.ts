import { getBaseName, getParentPath, type MediaType } from "@latch-works/media-domain";
import { originalObjectKey } from "@latch-works/media-storage";
import { eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects, syncRunItems, syncRuns } from "../db/schema";

export interface StartSyncRunInput {
  counts?: Record<string, number>;
  sourceRoot: string;
}

export interface CompleteObjectInput {
  contentType: string;
  extension: string;
  filename: string;
  logicalPath: string;
  mediaType: MediaType;
  mtimeMs: number;
  objectKey?: string;
  sha256: string;
  size: number;
  syncRunId: string;
}

export interface RemoteSyncSnapshotEntry {
  path: string;
  sha256?: string;
  size: number;
}

export async function listRemoteSyncSnapshot(): Promise<{
  entries: RemoteSyncSnapshotEntry[];
  status: "database";
}> {
  const entries = await db
    .select({
      path: libraryEntries.logicalPath,
      sha256: mediaObjects.sha256,
      size: mediaObjects.size,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(isNull(libraryEntries.deletedAt));

  return {
    entries,
    status: "database",
  };
}

export async function startSyncRun({
  input,
}: {
  input: StartSyncRunInput;
}): Promise<{ status: "database"; syncRunId: string }> {
  const [syncRun] = await db
    .insert(syncRuns)
    .values({
      counts: input.counts ?? {},
      sourceRoot: input.sourceRoot,
      status: "running",
    })
    .returning({ id: syncRuns.id });

  if (!syncRun) {
    throw new Error("Unable to create sync run.");
  }

  return {
    status: "database",
    syncRunId: syncRun.id,
  };
}

export async function completeSyncedObject({
  input,
}: {
  input: CompleteObjectInput;
}): Promise<{ status: "database" }> {
  const parentPath = getParentPath(input.logicalPath);
  const objectKey =
    input.objectKey ??
    originalObjectKey({
      extension: input.extension,
      mediaType: input.mediaType,
      sha256: input.sha256,
    });

  const [mediaObject] = await db
    .insert(mediaObjects)
    .values({
      contentType: input.contentType,
      extension: input.extension,
      mediaType: input.mediaType,
      objectKey,
      sha256: input.sha256,
      size: input.size,
    })
    .onConflictDoUpdate({
      set: {
        contentType: input.contentType,
        extension: input.extension,
        mediaType: input.mediaType,
        objectKey,
        size: input.size,
      },
      target: mediaObjects.sha256,
    })
    .returning({ id: mediaObjects.id });

  if (!mediaObject) {
    throw new Error("Unable to upsert media object.");
  }

  await upsertContainingFolders(parentPath);

  await db
    .insert(libraryEntries)
    .values({
      filename: input.filename,
      lastSeenAt: new Date(),
      logicalPath: input.logicalPath,
      mediaObjectId: mediaObject.id,
      mtimeMs: input.mtimeMs,
      parentPath,
    })
    .onConflictDoUpdate({
      set: {
        deletedAt: null,
        filename: input.filename,
        lastSeenAt: new Date(),
        mediaObjectId: mediaObject.id,
        mtimeMs: input.mtimeMs,
        parentPath,
      },
      target: libraryEntries.logicalPath,
    });

  await db
    .insert(syncRunItems)
    .values({
      action: "upload",
      logicalPath: input.logicalPath,
      mediaObjectId: mediaObject.id,
      syncRunId: input.syncRunId,
    })
    .onConflictDoUpdate({
      set: {
        action: "upload",
        error: null,
        mediaObjectId: mediaObject.id,
      },
      target: [syncRunItems.syncRunId, syncRunItems.logicalPath],
    });

  return { status: "database" };
}

export async function markRemoteDeleted({
  logicalPath,
  syncRunId,
}: {
  logicalPath: string;
  syncRunId: string;
}): Promise<{ status: "database" }> {
  await db
    .update(libraryEntries)
    .set({ deletedAt: new Date() })
    .where(eq(libraryEntries.logicalPath, logicalPath));

  await db
    .insert(syncRunItems)
    .values({
      action: "delete",
      logicalPath,
      syncRunId,
    })
    .onConflictDoUpdate({
      set: {
        action: "delete",
      },
      target: [syncRunItems.syncRunId, syncRunItems.logicalPath],
    });

  return { status: "database" };
}

export function collectContainingFolderPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const folders: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    folders.push(parts.slice(0, index + 1).join("/"));
  }

  return folders;
}

async function upsertContainingFolders(path: string): Promise<void> {
  if (!path) {
    return;
  }

  for (const folderPath of collectContainingFolderPaths(path)) {
    await db
      .insert(folders)
      .values({
        name: getBaseName(folderPath),
        parentPath: getParentPath(folderPath),
        path: folderPath,
      })
      .onConflictDoUpdate({
        set: {
          name: getBaseName(folderPath),
          parentPath: getParentPath(folderPath),
          updatedAt: new Date(),
        },
        target: folders.path,
      });
  }
}
