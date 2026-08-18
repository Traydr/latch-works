import type { GallerySortMode } from "@latch-works/media-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import * as schema from "../db/schema";
import {
  buildComicCoverQuery,
  buildComicPagesQuery,
  buildComicSummaryQuery,
  compareComicPages,
  isComicInBrowseScope,
} from "./comic-listing";
import type { GalleryListingCursorPayload } from "./gallery-listing";

/**
 * Pins the shape of the two-phase comic listing (Plan 051, Decision 5) and
 * the comic-by-id read. Behaviour is proven against executed SQL in
 * gallery-listing.pglite.test.ts; these strings guard against an accidental
 * rewrite that returns page rows instead of aggregates, drops the leaf test,
 * or loses the natural collation.
 */

/** A query builder with no connection: these tests read rendered SQL only. */
const database = drizzle.mock({ schema });

const SEED = "0123456789abcdef0123456789abcdef";
const SORT_MODES: GallerySortMode[] = [
  "name-asc",
  "name-desc",
  "date-newest",
  "date-oldest",
  "random",
];

function render(query: { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql, params } = query.toSQL();
  return { params, sql: sql.replace(/\s+/gu, " ") };
}

function summary(
  sortMode: GallerySortMode,
  cursor: Extract<GalleryListingCursorPayload, { subjectKind: "comic" }> | null = null,
) {
  return render(
    buildComicSummaryQuery(
      {
        currentPath: "photos",
        cursor,
        limit: 48,
        randomSeed: SEED,
        showImages: true,
        showVideos: true,
        sortMode,
      },
      database,
    ),
  );
}

const ELIGIBILITY =
  '"library_entries"."deleted_at" is null and "library_entries"."logical_path" ilike $1 ' +
  'and "media_objects"."media_type" in ($2, $3) and "library_entries"."parent_path" <> $4';

const LEAF =
  'not exists (select 1 from "folders" where ("folders"."parent_path" = "library_entries"."parent_path" and "folders"."deleted_at" is null))';

describe("comic summary query (phase 1)", () => {
  it("aggregates eligible pages per leaf folder and returns limit + 1 rows", () => {
    const { params, sql } = summary("name-asc");
    expect(sql).toBe(
      'select "library_entries"."parent_path", max("library_entries"."mtime_ms") as "newest_mtime", ' +
        'min("library_entries"."mtime_ms") as "oldest_mtime", count(*) as "page_count" ' +
        'from "library_entries" inner join "media_objects" on "library_entries"."media_object_id" = "media_objects"."id" ' +
        `where (${ELIGIBILITY} and ${LEAF}) ` +
        'group by "library_entries"."parent_path" ' +
        'order by "library_entries"."parent_path" COLLATE "natural" asc limit $5',
    );
    expect(params).toEqual(["photos/%", "image", "gif", "photos", 49]);
  });

  it.each(SORT_MODES)("%s: orders and continues in agreeing directions", (sortMode) => {
    const first = summary(sortMode);
    const continued = summary(sortMode, {
      folderPath: "photos/comic-a",
      mtimeMs: 1_700_000_000_000,
      randomKey: "89abcdef0123456789abcdef01234567",
      randomSeed: SEED,
      sortMode,
      subjectKind: "comic",
    });
    const orderBy = (sql: string) =>
      sql
        .slice(sql.indexOf(" order by ") + 10, sql.lastIndexOf(" limit "))
        .replace(/\$\d+/gu, "$n");
    expect(orderBy(continued.sql)).toBe(orderBy(first.sql));

    const having = continued.sql.slice(
      continued.sql.indexOf(" having ") + 8,
      continued.sql.indexOf(" order by "),
    );
    expect(first.sql).not.toContain(" having ");
    const leading = orderBy(first.sql).split(", ")[0] ?? "";
    expect(having.split(" or ")[0]).toContain(leading.endsWith(" desc") ? " < " : " > ");
  });

  it("date-newest ranks by the newest page and continues on (max mtime, natural path)", () => {
    const { sql } = summary("date-newest", {
      folderPath: "photos/comic-a",
      mtimeMs: 5,
      randomSeed: SEED,
      sortMode: "date-newest",
      subjectKind: "comic",
    });
    expect(sql).toContain(
      'having (max("library_entries"."mtime_ms") < $5 or (max("library_entries"."mtime_ms") = $6 ' +
        'and "library_entries"."parent_path" COLLATE "natural" > $7)) ' +
        'order by max("library_entries"."mtime_ms") desc, "library_entries"."parent_path" COLLATE "natural" asc',
    );
  });

  it("random ranks by the shared key over (comic, folder path)", () => {
    const { params, sql } = summary("random");
    expect(sql).toContain(
      "order by md5(concat($5::text, ':', $6::text, ':', \"library_entries\".\"parent_path\"::text)) asc, " +
        '"library_entries"."parent_path" asc',
    );
    expect(params.slice(4, 6)).toEqual([SEED, "comic"]);
  });

  it("applies the search to pages before grouping and the visibility toggles to page types", () => {
    const { params, sql } = render(
      buildComicSummaryQuery(
        {
          currentPath: "photos",
          cursor: null,
          limit: 48,
          query: "cover",
          randomSeed: SEED,
          showImages: false,
          showVideos: false,
          sortMode: "name-asc",
        },
        database,
      ),
    );
    expect(sql).toContain(
      '("library_entries"."logical_path" ilike $1 or "library_entries"."filename" ilike $2) ' +
        'and "media_objects"."media_type" in ($3, $4) and "media_objects"."media_type" not in ($5, $6) ' +
        'and "media_objects"."media_type" <> $7',
    );
    expect(params.slice(0, 7)).toEqual([
      "%cover%",
      "%cover%",
      "image",
      "gif",
      "image",
      "gif",
      "video",
    ]);
  });
});

describe("comic cover query (phase 2)", () => {
  it("selects one row per listed folder: the first page under the natural collation, then id", () => {
    const { params, sql } = render(
      buildComicCoverQuery(
        {
          currentPath: "photos",
          folderPaths: ["photos/comic-a", "photos/comic-b"],
          showImages: true,
          showVideos: true,
        },
        database,
      ),
    );
    expect(sql).toMatch(/^select distinct on \("library_entries"\."parent_path"\) /u);
    expect(sql).toContain(`where (${ELIGIBILITY} and "library_entries"."parent_path" in ($5, $6))`);
    expect(sql).toMatch(
      / order by "library_entries"\."parent_path" asc, "library_entries"\."filename" COLLATE "natural" asc, "library_entries"\."id" asc$/u,
    );
    expect(params.slice(4)).toEqual(["photos/comic-a", "photos/comic-b"]);
  });
});

describe("comic pages query", () => {
  it("selects every eligible page of one leaf folder", () => {
    const { params, sql } = render(
      buildComicPagesQuery(
        {
          comicId: "photos/comic-a",
          currentPath: "photos",
          showImages: true,
          showVideos: true,
        },
        database,
      ),
    );
    expect(sql).toContain(
      `where (${ELIGIBILITY} and "library_entries"."parent_path" = $5 and ${LEAF})`,
    );
    expect(sql).not.toContain(" limit ");
    expect(params).toEqual(["photos/%", "image", "gif", "photos", "photos/comic-a"]);
  });
});

describe("comic scope and page order", () => {
  it("accepts folders strictly inside the browse path, or anywhere but the path itself when searching", () => {
    expect(isComicInBrowseScope("photos/comic-a", "photos")).toBe(true);
    expect(isComicInBrowseScope("photos/comic-a", "")).toBe(true);
    expect(isComicInBrowseScope("photos", "photos")).toBe(false);
    expect(isComicInBrowseScope("photosx/comic-a", "photos")).toBe(false);
    expect(isComicInBrowseScope("other/comic-a", "photos")).toBe(false);
    expect(isComicInBrowseScope("", "")).toBe(false);
    // A search lists comics across the archive (like the media search); they must open.
    expect(isComicInBrowseScope("other/comic-a", "photos", true)).toBe(true);
    expect(isComicInBrowseScope("photos", "photos", true)).toBe(false);
  });

  it("orders pages naturally, then bytewise, then by id", () => {
    const page = (name: string, id: string) => ({
      extension: "jpg",
      id,
      mediaType: "image" as const,
      mtimeMs: 0,
      name,
      parentPath: "c",
      path: `c/${name}`,
      size: 1,
    });
    const pages = [page("10.jpg", "3"), page("a.jpg", "2"), page("2.jpg", "4"), page("A.jpg", "1")];
    expect([...pages].sort(compareComicPages).map((item) => item.name)).toEqual([
      "2.jpg",
      "10.jpg",
      "A.jpg",
      "a.jpg",
    ]);
  });
});
