import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

export type MediaScope =
  | { mode: "all" }
  | { mode: "direct-children"; parentPath: string }
  | { mode: "search" }
  | { mode: "subtree"; pathPrefix: string };

export function resolveMediaScope({
  currentPath,
  recursive,
  searching,
}: {
  currentPath: string;
  recursive: boolean;
  searching: boolean;
}): MediaScope {
  if (searching) {
    return { mode: "search" };
  }

  if (recursive) {
    if (currentPath) {
      return { mode: "subtree", pathPrefix: currentPath };
    }

    return { mode: "all" };
  }

  return { mode: "direct-children", parentPath: currentPath };
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
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
