import { eq, ilike, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import type { GalleryMedia } from "@/features/library/listing-contract";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import { escapeLikePattern, isNotUnderPath, isUnderPath } from "./folder-path-sql";

export interface LibraryConditionsInput {
  currentPath: string;
  /**
   * Direct-child folders of `currentPath` whose subtrees a recursive browse
   * subtracts (Plan 054). Entries that are not direct children — stale or
   * malformed client data — are ignored, and the whole list is ignored
   * outside subtree scope (non-recursive browsing, search, the root).
   */
  excludedPaths?: readonly string[];
  /** Already normalized (listing-contract); present means search mode. */
  query?: string;
  recursive: boolean;
}

export interface LibraryConditions {
  /** Non-deleted folders in scope: direct children when browsing, name matches when searching. */
  folderConditions: SQL[];
  /** Non-deleted entries in scope: direct children, subtree, or path/filename matches. */
  mediaConditions: SQL[];
  /** True when a query is present and search mode replaced the path scope. */
  searching: boolean;
}

/**
 * The one place the browse scope (path, recursive, query) becomes SQL. Both
 * snapshot and listing reads, and the comic summary listing, start from this.
 */
export function buildLibraryConditions({
  currentPath,
  excludedPaths,
  query,
  recursive,
}: LibraryConditionsInput): LibraryConditions {
  const mediaConditions: SQL[] = [isNull(libraryEntries.deletedAt)];
  const folderConditions: SQL[] = [isNull(folders.deletedAt)];

  if (query) {
    const queryPattern = `%${escapeLikePattern(query)}%`;

    const mediaQueryCondition = or(
      ilike(libraryEntries.logicalPath, queryPattern),
      ilike(libraryEntries.filename, queryPattern),
    );

    if (mediaQueryCondition) {
      mediaConditions.push(mediaQueryCondition);
    }

    // Names only: a path match would pull in every folder under a matching one.
    folderConditions.push(ilike(folders.name, queryPattern));
  } else {
    folderConditions.push(eq(folders.parentPath, currentPath));

    if (!recursive) {
      mediaConditions.push(eq(libraryEntries.parentPath, currentPath));
    } else if (currentPath) {
      mediaConditions.push(isUnderPath(libraryEntries.logicalPath, currentPath));

      for (const excluded of directChildExcludes(currentPath, excludedPaths)) {
        mediaConditions.push(isNotUnderPath(libraryEntries.logicalPath, excluded));
      }
    }
  }

  return { folderConditions, mediaConditions, searching: Boolean(query) };
}

/**
 * The excludable set for a browse path is its direct child folders (Plan 054,
 * Decision 1). This is the one owner of that rule and of the dedupe; anything
 * else in the list is dropped here, so stale or malformed client data is inert
 * instead of an error.
 */
function directChildExcludes(currentPath: string, excludedPaths: readonly string[] = []): string[] {
  const prefix = `${currentPath}/`;

  const directChildren = excludedPaths.filter((excluded) => {
    const segment = excluded.startsWith(prefix) ? excluded.slice(prefix.length) : "";

    return segment !== "" && !segment.includes("/");
  });

  return [...new Set(directChildren)];
}

/** Media-type filters from the gallery visibility toggles. */
export function buildMediaVisibilityConditions({
  showImages,
  showVideos,
}: {
  showImages: boolean;
  showVideos: boolean;
}): SQL[] {
  const conditions: SQL[] = [];

  if (!showImages) {
    conditions.push(notInArray(mediaObjects.mediaType, ["image", "gif"]));
  }

  if (!showVideos) {
    conditions.push(ne(mediaObjects.mediaType, "video"));
  }

  return conditions;
}

export type MediaRow = {
  entry: typeof libraryEntries.$inferSelect;
  object: typeof mediaObjects.$inferSelect;
};

export function mapMediaRows(rows: readonly MediaRow[]): GalleryMedia[] {
  return rows.map(({ entry, object }) => ({
    extension: object.extension,
    id: entry.id,
    mediaType: object.mediaType,
    mtimeMs: entry.mtimeMs,
    name: entry.filename,
    parentPath: entry.parentPath,
    path: entry.logicalPath,
    sha256: object.sha256,
    size: object.size,
  }));
}
