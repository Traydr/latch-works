import { eq, like, notLike, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { escapeLikePattern } from "./query-helpers";

/*
 * The SQL for "where is this path in the folder tree". Stored paths are
 * case-sensitive, so every predicate here is too: `photos` never reaches
 * `Photos/…`. They match with LIKE, never ILIKE, and compare whole segments.
 */

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
export function withAncestorPaths(seed: SQLWrapper): SQL {
  return sql`with recursive seeded (path) as (
    ${seed}
    union
    select substring(path from '^(.*)/[^/]*$') from seeded where strpos(path, '/') > 0
  ) select path from seeded`;
}
