import { getBaseName, getParentPath, type MediaType } from "@latch-works/media-domain";
import {
  headStoredObject,
  type S3StorageClient,
  type StoredObjectHead,
} from "@latch-works/media-storage";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Database, db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import {
  folders,
  libraryEntries,
  mediaObjects,
  shutterSourceCleanup,
  syncRunItems,
  syncRuns,
} from "../db/schema";
import { withAncestorPaths } from "../library/folder-path-sql";
import { assertNoActiveCleanupJob } from "../management/guards";
import { getPaneViewStorageClient } from "../media/storage-client";
import {
  InvalidSyncPathError,
  SyncRunConflictError,
  SyncRunNotFoundError,
  UploadMismatchError,
} from "./errors";
import { normalizeSyncLogicalPath, validateSyncLogicalPath } from "./validation";

type SyncDbClient = Pick<Database, "insert" | "select" | "update">;

/**
 * What the sync writes reach outside their own module: the archive database,
 * the coordination lock and cleanup guard that keep a sync from racing a
 * maintenance job, and the object storage HEAD that attests an upload.
 */
export interface SyncStoreDependencies {
  acquireLibraryMutationStartupLock(tx: Database): Promise<void>;
  assertNoActiveCleanupJob(client: Database): Promise<void>;
  database: Database;
  headStoredObject(request: {
    key: string;
    storage: S3StorageClient;
  }): Promise<StoredObjectHead | null>;
}

const defaultSyncStoreDependencies: SyncStoreDependencies = {
  acquireLibraryMutationStartupLock,
  assertNoActiveCleanupJob,
  database: db,
  headStoredObject,
};

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

export async function listRemoteSyncSnapshot(
  dependencies: SyncStoreDependencies = defaultSyncStoreDependencies,
): Promise<{
  entries: RemoteSyncSnapshotEntry[];
  status: "database";
}> {
  const entries = await dependencies.database
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

export async function startSyncRun(
  { input }: { input: StartSyncRunInput },
  dependencies: SyncStoreDependencies = defaultSyncStoreDependencies,
): Promise<{ status: "database"; syncRunId: string }> {
  const syncRunId = await dependencies.database.transaction(async (tx) => {
    await dependencies.acquireLibraryMutationStartupLock(tx);
    await dependencies.assertNoActiveCleanupJob(tx);

    const [syncRun] = await tx
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

    return syncRun.id;
  });

  return {
    status: "database",
    syncRunId,
  };
}

export async function completeSyncedObject(
  {
    input,
    storage = getPaneViewStorageClient(),
  }: {
    input: CompleteObjectInput;
    storage?: S3StorageClient;
  },
  dependencies: SyncStoreDependencies = defaultSyncStoreDependencies,
): Promise<{ status: "database" }> {
  const parentPath = getParentPath(input.logicalPath);
  const objectKey = input.objectKey;
  const expectedChecksum = Buffer.from(input.sha256.toLowerCase(), "hex").toString("base64");

  const head = await dependencies.headStoredObject({ key: objectKey, storage });

  if (!head) {
    throw new UploadMismatchError("Uploaded object was not found in storage.");
  }

  if (head.contentLength !== input.size) {
    throw new UploadMismatchError("Uploaded object size does not match declared size.");
  }

  if (head.contentType && head.contentType !== input.contentType) {
    throw new UploadMismatchError("Uploaded object content type does not match declared type.");
  }

  const metadataSha = head.metadata?.sha256?.toLowerCase();

  if (metadataSha && metadataSha !== input.sha256.toLowerCase()) {
    throw new UploadMismatchError("Uploaded object sha256 metadata does not match declared hash.");
  }

  if (head.checksumSHA256 && head.checksumSHA256 !== expectedChecksum) {
    throw new UploadMismatchError("Uploaded object checksum does not match declared hash.");
  }

  await dependencies.database.transaction(async (tx) => {
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

    // The content is live again and Shutter will cache it again, so forget any
    // queued or finished purge of it: its next delete queues a fresh one.
    await tx.delete(shutterSourceCleanup).where(eq(shutterSourceCleanup.sha256, input.sha256));

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

export async function finalizeSyncRun(
  { input }: { input: FinalizeSyncRunInput },
  dependencies: SyncStoreDependencies = defaultSyncStoreDependencies,
): Promise<{ status: "database" }> {
  const finalized = await dependencies.database.transaction(async (tx) => {
    const [syncRun] = await tx
      .update(syncRuns)
      .set({
        completedAt: new Date(),
        counts: input.counts ?? {},
        error: input.error ?? null,
        status: input.status,
      })
      .where(and(eq(syncRuns.id, input.syncRunId), eq(syncRuns.status, "running")))
      .returning({ id: syncRuns.id });

    if (!syncRun) {
      return false;
    }

    await softDeleteEmptiedFolders(tx);

    return true;
  });

  if (finalized) {
    return { status: "database" };
  }

  const [existingSyncRun] = await dependencies.database
    .select({ status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.id, input.syncRunId))
    .limit(1);

  if (!existingSyncRun) {
    throw new SyncRunNotFoundError();
  }

  if (existingSyncRun.status === input.status) {
    return { status: "database" };
  }

  throw new SyncRunConflictError(`Sync run is already ${existingSyncRun.status}.`);
}

export async function markRemoteDeleted(
  { logicalPath, syncRunId }: { logicalPath: string; syncRunId: string },
  dependencies: SyncStoreDependencies = defaultSyncStoreDependencies,
): Promise<{ status: "database" }> {
  const normalizedPath = normalizeSyncLogicalPath(logicalPath);
  const pathError = validateSyncLogicalPath(normalizedPath);

  if (pathError) {
    throw new InvalidSyncPathError(pathError);
  }

  await dependencies.database.transaction(async (tx) => {
    await assertWritableSyncRun(tx, syncRunId);

    await tx
      .update(libraryEntries)
      .set({ deletedAt: new Date() })
      .where(eq(libraryEntries.logicalPath, normalizedPath));

    await tx
      .insert(syncRunItems)
      .values({
        action: "delete",
        logicalPath: normalizedPath,
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

function collectContainingFolderPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const folders: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    folders.push(parts.slice(0, index + 1).join("/"));
  }

  return folders;
}

/**
 * Holds the run row FOR SHARE until the write's transaction ends, so a
 * force-cancel waits for the write instead of letting a purge scheduled after
 * the cancel miss the entry it relinks.
 */
async function assertWritableSyncRun(tx: SyncDbClient, syncRunId: string): Promise<void> {
  const [syncRun] = await tx
    .select({ id: syncRuns.id, status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.id, syncRunId))
    .limit(1)
    .for("share");

  if (!syncRun) {
    throw new SyncRunNotFoundError();
  }

  if (syncRun.status !== "running") {
    throw new SyncRunConflictError("Sync run is not accepting writes.");
  }
}

async function upsertContainingFolders(path: string, dbClient: SyncDbClient): Promise<void> {
  if (!path) {
    return;
  }

  const folderPaths = collectContainingFolderPaths(path);

  const existingRows = await dbClient
    .select({
      deletedAt: folders.deletedAt,
      id: folders.id,
      parentId: folders.parentId,
      path: folders.path,
    })
    .from(folders)
    .where(inArray(folders.path, folderPaths));

  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
  const parentIdByPath = new Map<string, string>();

  for (const folderPath of folderPaths) {
    const parentPath = getParentPath(folderPath);
    const depth = folderPath.split("/").filter(Boolean).length;
    // Paths run root first, so a parent's row was already read or written above.
    const parentId = parentPath ? (parentIdByPath.get(parentPath) ?? null) : null;
    const existing = existingByPath.get(folderPath);

    // Most files land in folders that are already live and linked. Leave those
    // rows alone: an upsert would rewrite and row-lock every ancestor (the root
    // included) until commit, serializing concurrent uploads on them.
    if (existing && existing.deletedAt === null && existing.parentId === parentId) {
      parentIdByPath.set(folderPath, existing.id);
      continue;
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
          deletedAt: null,
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

/**
 * Sync only creates a folder row for a folder that holds files, so a folder
 * with no live entry anywhere beneath it was emptied or renamed locally.
 * Soft-delete it with the entries that left it, or it lingers as an empty card
 * and stops its parent counting as a comic leaf.
 */
export async function softDeleteEmptiedFolders(tx: SyncDbClient): Promise<void> {
  const occupiedPaths = withAncestorPaths(
    tx
      .select({ path: libraryEntries.parentPath })
      .from(libraryEntries)
      .where(isNull(libraryEntries.deletedAt)),
  );

  await tx
    .update(folders)
    .set({ deletedAt: new Date() })
    .where(and(isNull(folders.deletedAt), sql`${folders.path} not in (${occupiedPaths})`));
}
