import { getBaseName, getParentPath, type MediaType } from "@latch-works/media-domain";
import type { RemoteEntry } from "@latch-works/sync-protocol";
import { eq, inArray, isNull } from "drizzle-orm";
import { type Database, db } from "../db";
import { assertNoActiveCleanupJob } from "../db/library-guards";
import {
  folders,
  libraryEntries,
  mediaObjects,
  shutterSourceCleanup,
  syncRunItems,
  syncRuns,
} from "../db/schema";
import {
  getPaneViewStorageClient,
  headStoredObject,
  SHA256_METADATA_KEY,
  type StoredObjectHead,
  sha256ChecksumHeader,
} from "../media/storage-client";
import { SyncRunConflictError, SyncRunNotFoundError, UploadMismatchError } from "./errors";

type SyncDbClient = Pick<Database, "insert" | "select" | "update">;

/**
 * What the sync writes reach outside their own module: the archive database
 * and the object storage HEAD that attests an upload.
 */
export interface SyncStoreDependencies {
  database: Database;
  headStoredObject(key: string): Promise<StoredObjectHead | null>;
}

const defaultSyncStoreDependencies: SyncStoreDependencies = {
  database: db,
  headStoredObject: (key) => headStoredObject({ key, storage: getPaneViewStorageClient() }),
};

/** A validated upload registration, its object key derived and its path normalized. */
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

/** A remote delete, its path normalized. */
export interface RemoteDeleteInput {
  logicalPath: string;
  syncRunId: string;
}

export async function listRemoteSyncSnapshot(
  database: Database = db,
): Promise<{ entries: RemoteEntry[] }> {
  const entries = await database
    .select({
      path: libraryEntries.logicalPath,
      sha256: mediaObjects.sha256,
      size: mediaObjects.size,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(isNull(libraryEntries.deletedAt));

  return { entries };
}

export async function completeSyncedObject(
  input: CompleteObjectInput,
  dependencies: SyncStoreDependencies = defaultSyncStoreDependencies,
): Promise<void> {
  const parentPath = getParentPath(input.logicalPath);
  const objectKey = input.objectKey;
  const expectedChecksum = sha256ChecksumHeader(input.sha256);

  const head = await dependencies.headStoredObject(objectKey);

  if (!head) {
    throw new UploadMismatchError("Uploaded object was not found in storage.");
  }

  if (head.contentLength !== input.size) {
    throw new UploadMismatchError("Uploaded object size does not match declared size.");
  }

  if (head.contentType && head.contentType !== input.contentType) {
    throw new UploadMismatchError("Uploaded object content type does not match declared type.");
  }

  const metadataSha = head.metadata?.[SHA256_METADATA_KEY]?.toLowerCase();

  if (metadataSha && metadataSha !== input.sha256) {
    throw new UploadMismatchError("Uploaded object sha256 metadata does not match declared hash.");
  }

  if (head.checksumSHA256 && head.checksumSHA256 !== expectedChecksum) {
    throw new UploadMismatchError("Uploaded object checksum does not match declared hash.");
  }

  await dependencies.database.transaction(async (tx) => {
    await assertSyncWriteAllowed(tx, input.syncRunId);

    const [mediaObject] = await tx
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
        logicalPath: input.logicalPath,
        mediaObjectId: mediaObject.id,
        mtimeMs: input.mtimeMs,
        parentPath,
      })
      .onConflictDoUpdate({
        set: {
          deletedAt: null,
          filename: input.filename,
          mediaObjectId: mediaObject.id,
          mtimeMs: input.mtimeMs,
          parentPath,
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
}

export async function markRemoteDeleted(
  { logicalPath, syncRunId }: RemoteDeleteInput,
  database: Database = db,
): Promise<void> {
  await database.transaction(async (tx) => {
    await assertSyncWriteAllowed(tx, syncRunId);

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
 * The prologue of every sync write, inside its transaction: no cleanup job may
 * be running, and the run must still accept writes. The run row is held FOR
 * SHARE until the transaction ends, so a force-cancel waits for the write
 * instead of letting a purge scheduled after the cancel miss the entry it
 * relinks.
 */
async function assertSyncWriteAllowed(tx: SyncDbClient, syncRunId: string): Promise<void> {
  await assertNoActiveCleanupJob(tx);

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
        name: getBaseName(folderPath),
        parentId,
        parentPath,
        path: folderPath,
      })
      .onConflictDoUpdate({
        set: {
          deletedAt: null,
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
