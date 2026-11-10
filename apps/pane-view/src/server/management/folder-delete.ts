import { and, count, isNull, or, type SQL } from "drizzle-orm";
import { normalizeArchivePath } from "@/features/library/listing-contract";
import { type Database, db } from "../db";
import { guardLibraryChange } from "../db/library-guards";
import { folders, libraryEntries } from "../db/schema";
import { isAtOrUnderPath, isUnderPath } from "../library/folder-path-sql";

export interface FolderDeleteResult {
  entriesDeleted: number;
  foldersDeleted: number;
  path: string;
}

/** The distinct normalized folder paths of a selection; refuses an empty one and the root. */
function deletableFolderPaths(folderPaths: readonly string[]): string[] {
  const paths = [...new Set(folderPaths.map(normalizeArchivePath))];

  if (paths.length === 0) {
    throw new Error("Select at least one folder to delete.");
  }

  if (paths.some((path) => path.split("/").includes(".."))) {
    throw new Error("Folder path must not contain '..' segments.");
  }

  if (paths.includes("")) {
    throw new Error("Cannot delete the archive root. Use library wipe instead.");
  }

  return paths;
}

/** Live entries in the folder at `path` or beneath it. */
function liveEntriesUnderPath(path: string): SQL | undefined {
  return and(isNull(libraryEntries.deletedAt), isUnderPath(libraryEntries.logicalPath, path));
}

/** How many live entries deleting `folderPaths` would soft-delete, each counted once. */
export async function countEntriesUnderPaths(
  folderPaths: string[],
  database: Database = db,
): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(libraryEntries)
    .where(or(...deletableFolderPaths(folderPaths).map(liveEntriesUnderPath)));

  return row?.value ?? 0;
}

/** Soft-delete folders and their subtrees, behind the library change guard. */
export async function softDeleteFolderSubtree(
  { folderPaths }: { folderPaths: string[] },
  database: Database = db,
): Promise<FolderDeleteResult[]> {
  const paths = deletableFolderPaths(folderPaths);
  const now = new Date();

  return database.transaction(async (tx) => {
    await guardLibraryChange(tx);

    const results: FolderDeleteResult[] = [];

    for (const path of paths) {
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
        .where(and(isNull(folders.deletedAt), isAtOrUnderPath(folders.path, path)))
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
