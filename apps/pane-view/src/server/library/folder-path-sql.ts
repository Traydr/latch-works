import { eq, isNull, like, notLike, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../db";
import { folders, libraryEntries } from "../db/schema";

/*
 * The SQL for "where is this path in the folder tree". Stored paths are
 * case-sensitive, so every predicate here is too: `photos` never reaches
 * `Photos/…`. They match with LIKE, never ILIKE, and compare whole segments.
 */

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function descendantPattern(path: string): string {
  return `${escapeLikePattern(path)}/%`;
}

/** `column` holds a path strictly beneath the folder at `path`. */
export function isUnderPath(column: AnyPgColumn, path: string): SQL {
  return like(column, descendantPattern(path));
}

/** `column` holds no path beneath the folder at `path`. */
export function isNotUnderPath(column: AnyPgColumn, path: string): SQL {
  return notLike(column, descendantPattern(path));
}

/** `column` holds `path` itself or a path beneath it. */
export function isAtOrUnderPath(column: AnyPgColumn, path: string): SQL | undefined {
  return or(eq(column, path), isUnderPath(column, path));
}

/**
 * Every path `seed` selects plus all of its ancestor folder paths, as a
 * subquery with one `path` column. The recursive walk strips one segment at a
 * time, so it costs the number of distinct paths, not folders times entries,
 * and it compares whole segments: `Photos/a` never makes `photos` an ancestor.
 */
function withAncestorPaths(seed: SQLWrapper): SQL {
  return sql`with recursive seeded (path) as (
    ${seed}
    union
    select substring(path from '^(.*)/[^/]*$') from seeded where strpos(path, '/') > 0
  ) select path from seeded`;
}

/**
 * The folder paths that hold a live entry somewhere beneath them, as a subquery with one `path`
 * column. With `countLiveFolders`, a folder that holds a live folder counts as occupied too.
 */
export function occupiedFolderPaths(
  client: Pick<Database, "select">,
  { countLiveFolders }: { countLiveFolders: boolean },
): SQL {
  const liveEntryFolders = client
    .select({ path: libraryEntries.parentPath })
    .from(libraryEntries)
    .where(isNull(libraryEntries.deletedAt));

  if (!countLiveFolders) return withAncestorPaths(liveEntryFolders);

  const liveFolders = client
    .select({ path: folders.path })
    .from(folders)
    .where(isNull(folders.deletedAt));

  return withAncestorPaths(sql`${liveEntryFolders} union ${liveFolders}`);
}
