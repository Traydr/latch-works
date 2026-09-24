import { toArchivePath, trimTrailingSlash } from "@latch-works/media-domain";
import { and, count, eq, isNull, like, or, type SQL } from "drizzle-orm";
import { type Database, db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { folders, libraryEntries } from "../db/schema";
import { escapeLikePattern } from "../library/query-helpers";
import { assertNoActiveCleanupJob, assertNoActiveSyncRun } from "./guards";

/**
 * The collaborators `softDeleteFolderSubtree` runs its prologue through. The
 * default instance below wires the real database, lock, and guards; a suite
 * substitutes its own to observe the prologue without a live archive.
 */
export interface FolderDeleteDependencies {
  acquireLibraryMutationStartupLock(tx: Database): Promise<void>;
  assertNoActiveCleanupJob(client: Database): Promise<void>;
  assertNoActiveSyncRun(client: Database): Promise<void>;
  database: Database;
}

const defaultFolderDeleteDependencies: FolderDeleteDependencies = {
  acquireLibraryMutationStartupLock,
  assertNoActiveCleanupJob,
  assertNoActiveSyncRun,
  database: db,
};

export interface FolderDeleteResult {
  entriesDeleted: number;
  foldersDeleted: number;
  path: string;
}

function normalizeFolderPath(path: string): string {
  const normalized = trimTrailingSlash(toArchivePath(path));

  if (normalized.split("/").includes("..")) {
    throw new Error("Folder path must not contain '..' segments.");
  }

  return normalized;
}

function assertDeletableFolderPath(path: string): void {
  if (!path) {
    throw new Error("Cannot delete the archive root. Use library wipe instead.");
  }
}

/**
 * Live entries in the folder at `path` or beneath it. Case-sensitive like the
 * stored paths: `photos` must not reach `Photos/…`.
 */
function liveEntriesUnderPath(path: string): SQL | undefined {
  const pattern = `${escapeLikePattern(path)}/%`;

  return and(
    isNull(libraryEntries.deletedAt),
    or(eq(libraryEntries.parentPath, path), like(libraryEntries.logicalPath, pattern)),
  );
}

/** How many live entries deleting `folderPaths` would soft-delete, each counted once. */
export async function countEntriesUnderPaths(
  folderPaths: string[],
  database: Database = db,
): Promise<number> {
  const normalizedPaths = [...new Set(folderPaths.map(normalizeFolderPath))];

  if (normalizedPaths.length === 0) {
    throw new Error("Select at least one folder to delete.");
  }

  for (const path of normalizedPaths) {
    assertDeletableFolderPath(path);
  }

  const [row] = await database
    .select({ value: count() })
    .from(libraryEntries)
    .where(or(...normalizedPaths.map(liveEntriesUnderPath)));

  return row?.value ?? 0;
}

/**
 * Soft-delete folders and their subtrees. Guarded like the maintenance
 * schedulers: never during a sync run (the sync would resurrect or fight the
 * rows) and never during a cleanup job (a purge may be hard-deleting the very
 * rows this marks). The guards run inside the mutation transaction under the
 * same library mutation startup lock the schedulers take, so a job cannot be
 * scheduled between the checks and the updates; and they live with the
 * mutation so no caller can skip them.
 */
export async function softDeleteFolderSubtree(
  { folderPaths }: { folderPaths: string[] },
  dependencies: FolderDeleteDependencies = defaultFolderDeleteDependencies,
): Promise<FolderDeleteResult[]> {
  const normalizedPaths = [...new Set(folderPaths.map(normalizeFolderPath))];

  if (normalizedPaths.length === 0) {
    throw new Error("Select at least one folder to delete.");
  }

  for (const path of normalizedPaths) {
    assertDeletableFolderPath(path);
  }

  const now = new Date();

  return dependencies.database.transaction(async (tx) => {
    await dependencies.acquireLibraryMutationStartupLock(tx);
    await dependencies.assertNoActiveSyncRun(tx);
    await dependencies.assertNoActiveCleanupJob(tx);

    const results: FolderDeleteResult[] = [];

    for (const path of normalizedPaths) {
      // Case-sensitive like the stored paths: deleting `photos` must not reach `Photos/…`.
      const pattern = `${escapeLikePattern(path)}/%`;

      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Overlapping folder selections must be updated in deterministic input order on one transaction.
      const deletedEntries = await tx
        .update(libraryEntries)
        .set({ deletedAt: now })
        .where(liveEntriesUnderPath(path))
        .returning({ id: libraryEntries.id });

      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Keep entry/folder counts paired before advancing to the next possibly overlapping subtree.
      const deletedFolders = await tx
        .update(folders)
        .set({ deletedAt: now })
        .where(
          and(isNull(folders.deletedAt), or(eq(folders.path, path), like(folders.path, pattern))),
        )
        .returning({ id: folders.id });

      results.push({
        entriesDeleted: deletedEntries.length,
        foldersDeleted: deletedFolders.length,
        path,
      });
    }

    return results;
  });
}
