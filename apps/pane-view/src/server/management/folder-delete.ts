import { toArchivePath, trimTrailingSlash } from "@latch-works/media-domain";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { folders, libraryEntries } from "../db/schema";
import { escapeLikePattern } from "../library/query-helpers";
import { assertNoActiveCleanupJob, assertNoActiveSyncRun } from "./guards";

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

export async function countEntriesUnderPath(path: string): Promise<number> {
  const normalizedPath = normalizeFolderPath(path);
  assertDeletableFolderPath(normalizedPath);

  const pattern = `${escapeLikePattern(normalizedPath)}/%`;
  const rows = await db
    .select({ id: libraryEntries.id })
    .from(libraryEntries)
    .where(
      and(
        isNull(libraryEntries.deletedAt),
        or(
          eq(libraryEntries.parentPath, normalizedPath),
          ilike(libraryEntries.logicalPath, pattern),
        ),
      ),
    );

  return rows.length;
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
export async function softDeleteFolderSubtree({
  folderPaths,
}: {
  folderPaths: string[];
}): Promise<FolderDeleteResult[]> {
  const normalizedPaths = [...new Set(folderPaths.map(normalizeFolderPath))];
  if (normalizedPaths.length === 0) {
    throw new Error("Select at least one folder to delete.");
  }

  for (const path of normalizedPaths) {
    assertDeletableFolderPath(path);
  }

  const now = new Date();

  return db.transaction(async (tx) => {
    await acquireLibraryMutationStartupLock(tx);
    await assertNoActiveSyncRun(tx);
    await assertNoActiveCleanupJob(tx);

    const results: FolderDeleteResult[] = [];

    for (const path of normalizedPaths) {
      const pattern = `${escapeLikePattern(path)}/%`;

      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Overlapping folder selections must be updated in deterministic input order on one transaction.
      const deletedEntries = await tx
        .update(libraryEntries)
        .set({ deletedAt: now })
        .where(
          and(
            isNull(libraryEntries.deletedAt),
            or(eq(libraryEntries.parentPath, path), ilike(libraryEntries.logicalPath, pattern)),
          ),
        )
        .returning({ id: libraryEntries.id });

      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Keep entry/folder counts paired before advancing to the next possibly overlapping subtree.
      const deletedFolders = await tx
        .update(folders)
        .set({ deletedAt: now })
        .where(
          and(isNull(folders.deletedAt), or(eq(folders.path, path), ilike(folders.path, pattern))),
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
