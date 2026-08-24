import { eq, ilike, isNull, ne, notIlike, notInArray, or, type SQL } from "drizzle-orm";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import { escapeLikePattern, resolveMediaScope } from "./query-helpers";
import type { LibraryMediaItem } from "./types";

export interface LibraryConditionsInput {
  currentPath: string;
  /**
   * Direct-child folders of `currentPath` whose subtrees a recursive browse
   * subtracts (Plan 054). Entries that are not direct children — stale or
   * malformed client data — are ignored, and the whole list is ignored
   * outside subtree scope (non-recursive browsing, search, the root).
   */
  excludedPaths?: readonly string[];
  query?: string;
  recursive: boolean;
}

export interface LibraryConditions {
  /** Non-deleted folders in scope: direct children when browsing, path/name matches when searching. */
  folderConditions: SQL[];
  /** Non-deleted entries in scope: direct children, subtree, or path/filename matches. */
  mediaConditions: SQL[];
  /** True when a trimmed query is present and search mode replaced the path scope. */
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
  const trimmedQuery = query?.trim();
  const searching = Boolean(trimmedQuery);
  const mediaScope = resolveMediaScope({ currentPath, recursive, searching });
  const mediaConditions: SQL[] = [isNull(libraryEntries.deletedAt)];
  const folderConditions: SQL[] = [isNull(folders.deletedAt)];

  if (searching && trimmedQuery) {
    const queryPattern = `%${escapeLikePattern(trimmedQuery)}%`;
    const mediaQueryCondition = or(
      ilike(libraryEntries.logicalPath, queryPattern),
      ilike(libraryEntries.filename, queryPattern),
    );
    const folderQueryCondition = or(
      ilike(folders.path, queryPattern),
      ilike(folders.name, queryPattern),
    );

    if (mediaQueryCondition) {
      mediaConditions.push(mediaQueryCondition);
    }

    if (folderQueryCondition) {
      folderConditions.push(folderQueryCondition);
    }
  } else {
    folderConditions.push(eq(folders.parentPath, currentPath));

    if (mediaScope.mode === "subtree") {
      mediaConditions.push(
        ilike(libraryEntries.logicalPath, `${escapeLikePattern(mediaScope.pathPrefix)}/%`),
      );
      for (const excluded of directChildExcludes(currentPath, excludedPaths)) {
        mediaConditions.push(
          notIlike(libraryEntries.logicalPath, `${escapeLikePattern(excluded)}/%`),
        );
      }
    } else if (mediaScope.mode === "direct-children") {
      mediaConditions.push(eq(libraryEntries.parentPath, mediaScope.parentPath));
    }
  }

  return { folderConditions, mediaConditions, searching };
}

/**
 * The excludable set for a browse path is its direct child folders (Plan 054,
 * Decision 1). Anything else in the list is dropped here so stale or malformed
 * client data is inert instead of an error.
 */
function directChildExcludes(
  currentPath: string,
  excludedPaths: readonly string[] = [],
): string[] {
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

export function mapMediaRowsToLibraryItems(rows: readonly MediaRow[]): LibraryMediaItem[] {
  return rows.map(({ entry, object }): LibraryMediaItem => {
    return {
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
    };
  });
}
