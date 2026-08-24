import { and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import * as schema from "../db/schema";
import { buildLibraryConditions, type LibraryConditionsInput } from "./library-conditions";

/**
 * Rendered-SQL coverage for the excluded-subtree subtraction (Plan 054).
 * The scope conditions themselves are pinned through the query builders in
 * repository.test.ts; executed behaviour lives in the pglite suite.
 */

/** A query builder with no connection: these tests read rendered SQL only. */
const database = drizzle.mock({ schema });

function renderMediaConditions(input: LibraryConditionsInput) {
  const { mediaConditions } = buildLibraryConditions(input);
  const { sql, params } = database
    .select({ id: schema.libraryEntries.id })
    .from(schema.libraryEntries)
    .where(and(...mediaConditions))
    .toSQL();
  return { params, sql: sql.replace(/\s+/gu, " ") };
}

const NOT_ILIKE = '"library_entries"."logical_path" not ilike ';

describe("buildLibraryConditions excluded subtrees", () => {
  it("subtracts one escaped prefix per excluded direct child in recursive mode", () => {
    const { params, sql } = renderMediaConditions({
      currentPath: "photos/2026_a%b",
      excludedPaths: ["photos/2026_a%b/kids", "photos/2026_a%b/x_y%z"],
      recursive: true,
    });

    expect(sql).toContain('"library_entries"."logical_path" ilike $1');
    expect(sql.split(NOT_ILIKE)).toHaveLength(3);
    expect(params).toEqual([
      "photos/2026\\_a\\%b/%",
      "photos/2026\\_a\\%b/kids/%",
      "photos/2026\\_a\\%b/x\\_y\\%z/%",
    ]);
  });

  it("ignores entries that are not direct children of the current path, and duplicates", () => {
    const { params } = renderMediaConditions({
      currentPath: "photos",
      excludedPaths: [
        "photos/kids/deeper", // grandchild
        "elsewhere/kids", // other subtree
        "photos", // the browse path itself
        "photosx/kids", // sibling prefix, not a child
        "", // malformed
        "photos/kids",
        "photos/kids", // duplicate
      ],
      recursive: true,
    });

    expect(params).toEqual(["photos/%", "photos/kids/%"]);
  });

  it("applies no exclusion outside subtree scope: non-recursive, search, and the root", () => {
    const excludedPaths = ["photos/kids"];
    const nonRecursive = renderMediaConditions({
      currentPath: "photos",
      excludedPaths,
      recursive: false,
    });
    const searching = renderMediaConditions({
      currentPath: "photos",
      excludedPaths,
      query: "kids",
      recursive: true,
    });
    const root = renderMediaConditions({ currentPath: "", excludedPaths, recursive: true });

    for (const rendered of [nonRecursive, searching, root]) {
      expect(rendered.sql).not.toContain(NOT_ILIKE);
    }
  });

  it("renders identically to a request without the field when the list is empty", () => {
    const base: LibraryConditionsInput = { currentPath: "photos", recursive: true };
    expect(renderMediaConditions({ ...base, excludedPaths: [] })).toEqual(
      renderMediaConditions(base),
    );
  });
});
