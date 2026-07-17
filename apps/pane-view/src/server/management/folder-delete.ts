import { toArchivePath, trimTrailingSlash } from "@latch-works/media-domain";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries } from "../db/schema";
import { escapeLikePattern } from "../library/query-helpers";

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
    const results: FolderDeleteResult[] = [];

    for (const path of normalizedPaths) {
      const pattern = `${escapeLikePattern(path)}/%`;

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
