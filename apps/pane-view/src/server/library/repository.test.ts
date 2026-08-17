import type { GallerySortMode } from "@latch-works/media-domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  // A query builder with no connection: these tests read rendered SQL only.
  return { db: drizzle.mock() };
});

import type { GalleryListingCursorPayload } from "./gallery-listing";
import {
  buildGalleryListingMediaQuery,
  buildLibraryFolderQuery,
  buildLibrarySnapshotMediaQuery,
  buildMediaPage,
} from "./repository";

/**
 * Nothing else renders the SQL that orders and pages the gallery. These tests
 * pin the query shape so an accidental rewrite of a builder (a flipped
 * comparison, a dropped tie-breaker, a lost LIKE escape) fails here instead of
 * in production. Behaviour against executed SQL lives in the pglite suite.
 */

const SORT_MODES: GallerySortMode[] = [
  "name-asc",
  "name-desc",
  "date-newest",
  "date-oldest",
  "random",
];

const SEED = "0123456789abcdef0123456789abcdef";

type MediaCursor = Extract<GalleryListingCursorPayload, { subjectKind: "media" }>;

const cursorFixture: Omit<MediaCursor, "sortMode"> = {
  filename: "cover.jpg",
  id: "00000000-0000-4000-8000-000000000001",
  logicalPath: "photos/2026/cover.jpg",
  mtimeMs: 1_700_000_000_000,
  randomKey: "89abcdef0123456789abcdef01234567",
  randomSeed: SEED,
  subjectKind: "media",
};

function render(query: { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql, params } = query.toSQL();
  return { params, sql: sql.replace(/\s+/gu, " ") };
}

function listing(
  overrides: Partial<Omit<Parameters<typeof buildGalleryListingMediaQuery>[0], "cursor">> & {
    /** When true, continue from `cursorFixture` under the request's sort mode. */
    continued?: boolean;
  } = {},
) {
  const { continued = false, ...request } = overrides;
  const sortMode = request.sortMode ?? "name-asc";
  return render(
    buildGalleryListingMediaQuery({
      currentPath: "photos",
      limit: 60,
      randomSeed: SEED,
      recursive: false,
      showImages: true,
      showVideos: true,
      ...request,
      cursor: continued ? { ...cursorFixture, sortMode } : null,
      sortMode,
    }),
  );
}

function orderByClause(sql: string): string {
  return sql.slice(sql.indexOf(" order by ") + " order by ".length, sql.lastIndexOf(" limit "));
}

function cursorClause(sql: string): string {
  // The cursor disjunction is the last top-level `and (...)` term before ORDER BY.
  const whereEnd = sql.indexOf(") order by ");
  const start = sql.lastIndexOf(" and (", whereEnd);
  return sql.slice(start + " and ".length, whereEnd);
}

describe("gallery listing order and cursor agree in direction", () => {
  it.each(
    SORT_MODES,
  )("%s: the leading disjunct continues in the ORDER BY direction", (sortMode) => {
    const first = listing({ sortMode });
    const continued = listing({ continued: true, sortMode });

    const orderBy = orderByClause(first.sql);
    const [leading, ...rest] = orderBy.split(", ");
    const leadingDirection = leading?.endsWith(" desc") ? "desc" : "asc";
    const cursor = cursorClause(continued.sql);
    const [leadingDisjunct] = cursor.slice(1, -1).split(" or ");

    // Parameter numbers shift once the cursor terms are bound; compare shape only.
    expect(orderByClause(continued.sql).replace(/\$\d+/gu, "$n")).toBe(
      orderBy.replace(/\$\d+/gu, "$n"),
    );
    expect(leadingDisjunct).toContain(leadingDirection === "desc" ? " < " : " > ");
    // Every mode ends on the id tie-breaker so the keyset is total.
    expect(rest.at(-1)).toMatch(/"library_entries"\."id" (asc|desc)$/u);
    expect(cursor).toContain('"library_entries"."id"');
  });

  // Plan 051 Decision 6: name modes order and continue under the natural
  // collation (migration 0018) so server order matches the client collator.
  it("orders name-asc by natural filename, natural logical path, id and continues with > on each", () => {
    const { sql } = listing({ continued: true, sortMode: "name-asc" });
    const filename = '"library_entries"."filename" COLLATE "natural"';
    const logicalPath = '"library_entries"."logical_path" COLLATE "natural"';
    expect(orderByClause(sql)).toBe(
      `${filename} asc, ${logicalPath} asc, "library_entries"."id" asc`,
    );
    expect(cursorClause(sql)).toBe(
      `(${filename} > $2 or ` +
        `(${filename} = $3 and ${logicalPath} > $4) or ` +
        `(${filename} = $5 and ${logicalPath} = $6 and "library_entries"."id" > $7))`,
    );
  });

  it("orders name-desc under the same collation with every comparison flipped", () => {
    const { sql } = listing({ continued: true, sortMode: "name-desc" });
    const filename = '"library_entries"."filename" COLLATE "natural"';
    const logicalPath = '"library_entries"."logical_path" COLLATE "natural"';
    expect(orderByClause(sql)).toBe(
      `${filename} desc, ${logicalPath} desc, "library_entries"."id" desc`,
    );
    expect(cursorClause(sql)).toBe(
      `(${filename} < $2 or ` +
        `(${filename} = $3 and ${logicalPath} < $4) or ` +
        `(${filename} = $5 and ${logicalPath} = $6 and "library_entries"."id" < $7))`,
    );
  });

  it("orders date-newest by mtime desc but continues logical path and id ascending", () => {
    const { sql } = listing({ continued: true, sortMode: "date-newest" });
    expect(orderByClause(sql)).toBe(
      '"library_entries"."mtime_ms" desc, "library_entries"."logical_path" asc, "library_entries"."id" asc',
    );
    expect(cursorClause(sql)).toBe(
      '("library_entries"."mtime_ms" < $2 or ' +
        '("library_entries"."mtime_ms" = $3 and "library_entries"."logical_path" > $4) or ' +
        '("library_entries"."mtime_ms" = $5 and "library_entries"."logical_path" = $6 and "library_entries"."id" > $7))',
    );
  });

  // Plan 051 Decision 2: random ranks by the shared key md5(seed:kind:id) so
  // media and comics never share a rank input, and the cursor carries the
  // last row's key.
  it("orders random by the shared seeded key over (media, id) and continues from the cursor key", () => {
    const { params, sql } = listing({ continued: true, sortMode: "random" });
    const key = (seed: number, kind: number) =>
      `md5(concat($${seed}::text, ':', $${kind}::text, ':', "library_entries"."id"::text))`;
    expect(orderByClause(sql)).toBe(
      `${key(14, 15)} asc, "library_entries"."logical_path" asc, "library_entries"."id" asc`,
    );
    expect(cursorClause(sql)).toBe(
      `(${key(2, 3)} > $4 or ` +
        `(${key(5, 6)} = $7 and "library_entries"."logical_path" > $8) or ` +
        `(${key(9, 10)} = $11 and "library_entries"."logical_path" = $12 and "library_entries"."id" > $13))`,
    );
    expect(params.slice(1, 15)).toEqual([
      SEED,
      "media",
      cursorFixture.randomKey,
      SEED,
      "media",
      cursorFixture.randomKey,
      cursorFixture.logicalPath,
      SEED,
      "media",
      cursorFixture.randomKey,
      cursorFixture.logicalPath,
      cursorFixture.id,
      SEED,
      "media",
    ]);
  });
});

describe("browse scope renders identically for both read paths", () => {
  it("root, non-recursive: direct children of the empty parent path", () => {
    const snapshot = render(
      buildLibrarySnapshotMediaQuery({ currentPath: "", limit: 500, recursive: false }),
    );
    const paged = listing({ currentPath: "" });

    const scope =
      'where ("library_entries"."deleted_at" is null and "library_entries"."parent_path" = $1';
    expect(snapshot.sql).toContain(scope);
    expect(paged.sql).toContain(scope);
    expect(snapshot.params[0]).toBe("");
    expect(paged.params[0]).toBe("");
  });

  it("recursive subtree: escapes % and _ in the path prefix and appends /%", () => {
    const currentPath = "photos/2026_a%b";
    const snapshot = render(
      buildLibrarySnapshotMediaQuery({ currentPath, limit: 500, recursive: true }),
    );
    const paged = listing({ currentPath, recursive: true });

    for (const rendered of [snapshot, paged]) {
      expect(rendered.sql).toContain('"library_entries"."logical_path" ilike $1');
      expect(rendered.params[0]).toBe("photos/2026\\_a\\%b/%");
    }
  });

  it("search: matches logical path or filename with an escaped pattern, ignoring the path scope", () => {
    const query = "cov_er%";
    const snapshot = render(
      buildLibrarySnapshotMediaQuery({
        currentPath: "photos",
        limit: 200,
        query,
        recursive: false,
      }),
    );
    const paged = listing({ query });

    for (const rendered of [snapshot, paged]) {
      expect(rendered.sql).toContain(
        '("library_entries"."logical_path" ilike $1 or "library_entries"."filename" ilike $2)',
      );
      expect(rendered.sql).not.toContain('"parent_path" =');
      expect(rendered.params.slice(0, 2)).toEqual(["%cov\\_er\\%%", "%cov\\_er\\%%"]);
    }
  });

  it("folder query searches path or name and otherwise lists direct children", () => {
    const browsing = render(buildLibraryFolderQuery({ currentPath: "photos", recursive: false }));
    const searching = render(buildLibraryFolderQuery({ currentPath: "photos", query: "x" }));

    expect(browsing.sql).toBe(
      'select "id", "path", "parent_path", "parent_id", "name", "depth", "entry_count", ' +
        '"folder_count", "created_at", "updated_at", "deleted_at" from "folders" ' +
        'where ("folders"."deleted_at" is null and "folders"."parent_path" = $1)',
    );
    expect(searching.sql).toContain(
      'where ("folders"."deleted_at" is null and ("folders"."path" ilike $1 or "folders"."name" ilike $2))',
    );
  });
});

describe("gallery listing filters and limits", () => {
  it("hides images and gifs when showImages is false", () => {
    const { params, sql } = listing({ showImages: false });
    expect(sql).toContain('"media_objects"."media_type" not in ($2, $3)');
    expect(params.slice(1, 3)).toEqual(["image", "gif"]);
  });

  it("hides videos when showVideos is false", () => {
    const { params, sql } = listing({ showVideos: false });
    expect(sql).toContain('"media_objects"."media_type" <> $2');
    expect(params[1]).toBe("video");
  });

  it("overfetches by one row so hasMore needs no count query", () => {
    const paged = listing({ continued: true, limit: 48, sortMode: "date-newest" });
    expect(paged.sql).toMatch(/ limit \$\d+$/u);
    expect(paged.params.at(-1)).toBe(49);

    const snapshot = render(
      buildLibrarySnapshotMediaQuery({ currentPath: "photos", limit: 500, offset: 500 }),
    );
    expect(snapshot.sql).toMatch(/ limit \$\d+ offset \$\d+$/u);
    expect(snapshot.params.slice(-2)).toEqual([501, 500]);
  });
});

describe("buildMediaPage", () => {
  it("returns hasMore when overfetch finds an extra row", () => {
    const page = buildMediaPage(["a", "b", "c"], 2, 0);

    expect(page.items).toEqual(["a", "b"]);
    expect(page.mediaPage).toEqual({ hasMore: true, limit: 2, nextOffset: 2, offset: 0 });
  });

  it("returns no next page when rows fit within the limit", () => {
    const page = buildMediaPage(["a", "b"], 2, 4);

    expect(page.items).toEqual(["a", "b"]);
    expect(page.mediaPage).toEqual({ hasMore: false, limit: 2, nextOffset: null, offset: 4 });
  });
});
