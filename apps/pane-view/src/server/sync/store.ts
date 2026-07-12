import { getBaseName, getParentPath, type MediaType } from "@latch-works/media-domain";
import { eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects, syncRunItems, syncRuns } from "../db/schema";
import { assertNoActiveCleanupJob } from "../management/guards";

type SyncDbClient = Pick<typeof db, "insert" | "select" | "update">;

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
  objectKey: string;
  sha256: string;
  size: number;
  syncRunId: string;
}

export interface FinalizeSyncRunInput {
  counts?: Record<string, number>;
  error?: string;
  status: "cancelled" | "completed" | "failed";
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
  await assertNoActiveCleanupJob();

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
  const objectKey = input.objectKey;

  await db.transaction(async (tx) => {
    await assertWritableSyncRun(tx, input.syncRunId);

    const [mediaObject] = await tx
      .insert(mediaObjects)
      .values({
        contentType: input.contentType,
        extension: input.extension,
        mediaType: input.mediaType,
        metadata: {},
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
        target: [mediaObjects.sha256, mediaObjects.size],
      })
      .returning({ id: mediaObjects.id });

    if (!mediaObject) {
      throw new Error("Unable to upsert media object.");
    }

    await upsertContainingFolders(parentPath, tx);

    await tx
      .insert(libraryEntries)
      .values({
        filename: input.filename,
        lastSeenAt: new Date(),
        logicalPath: input.logicalPath,
        mediaObjectId: mediaObject.id,
        metadata: {},
        mtimeMs: input.mtimeMs,
        parentPath,
        sha256: input.sha256,
        size: input.size,
      })
      .onConflictDoUpdate({
        set: {
          deletedAt: null,
          filename: input.filename,
          lastSeenAt: new Date(),
          mediaObjectId: mediaObject.id,
          metadata: {},
          mtimeMs: input.mtimeMs,
          parentPath,
          sha256: input.sha256,
          size: input.size,
        },
        target: libraryEntries.logicalPath,
      });

    await tx
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
  });

  return { status: "database" };
}

export async function finalizeSyncRun({
  input,
}: {
  input: FinalizeSyncRunInput;
}): Promise<{ status: "database" }> {
  const [syncRun] = await db
    .update(syncRuns)
    .set({
      completedAt: new Date(),
      counts: input.counts ?? {},
      error: input.error ?? null,
      status: input.status,
    })
    .where(eq(syncRuns.id, input.syncRunId))
    .returning({ id: syncRuns.id });

  if (!syncRun) {
    throw new Error("Unable to finalize sync run.");
  }

  return { status: "database" };
}

export async function markRemoteDeleted({
  logicalPath,
  syncRunId,
}: {
  logicalPath: string;
  syncRunId: string;
}): Promise<{ status: "database" }> {
  await db.transaction(async (tx) => {
    await assertWritableSyncRun(tx, syncRunId);

    await tx
      .update(libraryEntries)
      .set({ deletedAt: new Date() })
      .where(eq(libraryEntries.logicalPath, logicalPath));

    await tx
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

async function assertWritableSyncRun(tx: SyncDbClient, syncRunId: string): Promise<void> {
  const [syncRun] = await tx
    .select({ id: syncRuns.id, status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.id, syncRunId))
    .limit(1);

  if (!syncRun) {
    throw new Error("Sync run not found.");
  }

  if (syncRun.status !== "running") {
    throw new Error("Sync run is not accepting writes.");
  }
}

async function upsertContainingFolders(path: string, dbClient: SyncDbClient): Promise<void> {
  if (!path) {
    return;
  }

  const parentIdByPath = new Map<string, string>();

  for (const folderPath of collectContainingFolderPaths(path)) {
    const parentPath = getParentPath(folderPath);
    const depth = folderPath.split("/").filter(Boolean).length;
    let parentId: string | null = null;

    if (parentPath) {
      parentId =
        parentIdByPath.get(parentPath) ??
        (
          await dbClient
            .select({ id: folders.id })
            .from(folders)
            .where(eq(folders.path, parentPath))
            .limit(1)
        )[0]?.id ??
        null;
    }

    const [folder] = await dbClient
      .insert(folders)
      .values({
        depth,
        name: getBaseName(folderPath),
        parentId,
        parentPath,
        path: folderPath,
      })
      .onConflictDoUpdate({
        set: {
          depth,
          name: getBaseName(folderPath),
          parentId,
          parentPath,
          updatedAt: new Date(),
        },
        target: folders.path,
      })
      .returning({ id: folders.id });

    if (folder) {
      parentIdByPath.set(folderPath, folder.id);
    }
  }
}
