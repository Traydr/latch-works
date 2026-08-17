import type { GallerySortMode, MediaType } from "@latch-works/media-domain";
import { buildComicEntries } from "@latch-works/media-domain";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Executed-SQL proof of the gallery ordering contract (Plan 051). Every test
 * follows cursors through the real listing queries against an in-process
 * PostgreSQL seeded with one deterministic fixture, and compares the
 * concatenated pages to an in-memory oracle that applies the documented rules
 * (Decision 6 tie-breaks, Decision 7 comic eligibility, the shared random
 * key). The oracle is a test double, not production code.
 */

const harness = vi.hoisted(() => ({
  handle: null as null | {
    close(): Promise<void>;
    client: { query(sql: string): Promise<{ rows: unknown[] }> };
  },
}));

vi.mock("../db", async () => {
  const { createTestDatabase } = await import("./test-db");
  const { buildLibraryFixture, seedLibraryFixture } = await import("./library-fixture");
  const handle = await createTestDatabase();
  await seedLibraryFixture(handle.db, buildLibraryFixture());
  harness.handle = handle;
  return { db: handle.db };
});

import { readDatabaseComicListing, readDatabaseGalleryComic } from "./comic-listing";
import { type GalleryRandomSeed, galleryRandomOrderKey } from "./gallery-order";
import { buildLibraryFixture, FIXTURE_SEARCH_TERM, type FixtureEntry } from "./library-fixture";
import { readDatabaseGalleryListing } from "./repository";

afterAll(async () => {
  await harness.handle?.close();
});

const fixture = buildLibraryFixture();
const liveEntries = fixture.entries.filter((entry) => !entry.deleted);
const liveFolders = fixture.folders.filter((folder) => !folder.deleted);
const parentPathsWithLiveChildFolders = new Set(
  liveFolders.map((folder) => folder.path.slice(0, folder.path.lastIndexOf("/"))),
);

const SEED_A: GalleryRandomSeed = "0123456789abcdef0123456789abcdef";
const SEED_B: GalleryRandomSeed = "fedcba9876543210fedcba9876543210";
const SORT_MODES: GallerySortMode[] = [
  "name-asc",
  "name-desc",
  "date-newest",
  "date-oldest",
  "random",
];

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

/** The client's collator: numeric digit runs, primary strength (case/accent-insensitive). */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Byte order for ASCII strings; the deterministic collation's tie-break. */
function bytes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `x COLLATE "natural"` as a total order: collator, then bytewise. */
function natural(left: string, right: string): number {
  return collator.compare(left, right) || bytes(left, right);
}

interface OracleMediaRequest {
  currentPath: string;
  query?: string;
  randomSeed: GalleryRandomSeed;
  recursive: boolean;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

function parentPathOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function inScope(
  entry: FixtureEntry,
  request: { currentPath: string; query?: string; recursive: boolean },
): boolean {
  if (request.query) {
    const needle = request.query.toLowerCase();
    return (
      entry.path.toLowerCase().includes(needle) || nameOf(entry.path).toLowerCase().includes(needle)
    );
  }
  if (request.recursive) {
    return request.currentPath === "" || entry.path.startsWith(`${request.currentPath}/`);
  }
  return parentPathOf(entry.path) === request.currentPath;
}

function visible(
  entry: FixtureEntry,
  request: { showImages: boolean; showVideos: boolean },
): boolean {
  if (!request.showImages && (entry.mediaType === "image" || entry.mediaType === "gif"))
    return false;
  if (!request.showVideos && entry.mediaType === "video") return false;
  return true;
}

function expectedMediaOrder(request: OracleMediaRequest): string[] {
  const subjects = liveEntries.filter(
    (entry) => inScope(entry, request) && visible(entry, request),
  );
  const byName = (a: FixtureEntry, b: FixtureEntry) =>
    natural(nameOf(a.path), nameOf(b.path)) || natural(a.path, b.path) || bytes(a.id, b.id);
  const byPathId = (a: FixtureEntry, b: FixtureEntry) => bytes(a.path, b.path) || bytes(a.id, b.id);
  const comparators: Record<GallerySortMode, (a: FixtureEntry, b: FixtureEntry) => number> = {
    "date-newest": (a, b) => b.mtimeMs - a.mtimeMs || byPathId(a, b),
    "date-oldest": (a, b) => a.mtimeMs - b.mtimeMs || byPathId(a, b),
    "name-asc": byName,
    "name-desc": (a, b) => byName(b, a),
    random: (a, b) =>
      bytes(
        galleryRandomOrderKey(request.randomSeed, "media", a.id),
        galleryRandomOrderKey(request.randomSeed, "media", b.id),
      ) || byPathId(a, b),
  };
  return [...subjects].sort(comparators[request.sortMode]).map((entry) => entry.id);
}

interface OracleComic {
  cover: FixtureEntry;
  folderPath: string;
  newest: number;
  oldest: number;
  pageCount: number;
  pages: FixtureEntry[];
}

interface OracleComicRequest {
  currentPath: string;
  query?: string;
  randomSeed: GalleryRandomSeed;
  showImages: boolean;
  showVideos: boolean;
  sortMode: GallerySortMode;
}

function comicPageComparator(a: FixtureEntry, b: FixtureEntry): number {
  return natural(nameOf(a.path), nameOf(b.path)) || bytes(a.id, b.id);
}

function eligibleComics(request: OracleComicRequest): Map<string, OracleComic> {
  const byFolder = new Map<string, FixtureEntry[]>();
  for (const entry of liveEntries) {
    if (entry.mediaType !== "image" && entry.mediaType !== "gif") continue;
    if (!inScope(entry, { ...request, recursive: true })) continue;
    if (!visible(entry, request)) continue;
    const folderPath = parentPathOf(entry.path);
    if (folderPath === request.currentPath) continue;
    if (parentPathsWithLiveChildFolders.has(folderPath)) continue;
    byFolder.set(folderPath, [...(byFolder.get(folderPath) ?? []), entry]);
  }
  const comics = new Map<string, OracleComic>();
  for (const [folderPath, pages] of byFolder) {
    const sorted = [...pages].sort(comicPageComparator);
    comics.set(folderPath, {
      cover: sorted[0] as FixtureEntry,
      folderPath,
      newest: Math.max(...pages.map((page) => page.mtimeMs)),
      oldest: Math.min(...pages.map((page) => page.mtimeMs)),
      pageCount: pages.length,
      pages: sorted,
    });
  }
  return comics;
}

function expectedComicOrder(request: OracleComicRequest): OracleComic[] {
  const comics = [...eligibleComics(request).values()];
  const comparators: Record<GallerySortMode, (a: OracleComic, b: OracleComic) => number> = {
    "date-newest": (a, b) => b.newest - a.newest || natural(a.folderPath, b.folderPath),
    "date-oldest": (a, b) => a.oldest - b.oldest || natural(a.folderPath, b.folderPath),
    "name-asc": (a, b) => natural(a.folderPath, b.folderPath),
    "name-desc": (a, b) => natural(b.folderPath, a.folderPath),
    random: (a, b) =>
      bytes(
        galleryRandomOrderKey(request.randomSeed, "comic", a.folderPath),
        galleryRandomOrderKey(request.randomSeed, "comic", b.folderPath),
      ) || bytes(a.folderPath, b.folderPath),
  };
  return comics.sort(comparators[request.sortMode]);
}

// ---------------------------------------------------------------------------
// Pagination drivers
// ---------------------------------------------------------------------------

async function collectMediaPages(request: OracleMediaRequest, limit: number) {
  const pages: Awaited<ReturnType<typeof readDatabaseGalleryListing>>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await readDatabaseGalleryListing({ ...request, cursor, limit });
    pages.push(page);
    if (!page.page.hasMore) break;
    if (!page.page.cursor || page.page.cursor === cursor) {
      throw new Error("cursor did not advance");
    }
    cursor = page.page.cursor;
  }
  return pages;
}

async function collectComicPages(request: OracleComicRequest, limit: number) {
  const pages: Awaited<ReturnType<typeof readDatabaseComicListing>>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await readDatabaseComicListing({ ...request, cursor, limit });
    pages.push(page);
    if (!page.page.hasMore) break;
    if (!page.page.cursor || page.page.cursor === cursor) {
      throw new Error("cursor did not advance");
    }
    cursor = page.page.cursor;
  }
  return pages;
}

const MEDIA_SHAPES: Record<string, Omit<OracleMediaRequest, "randomSeed" | "sortMode">> = {
  "non-recursive folder": {
    currentPath: "alpha",
    recursive: false,
    showImages: true,
    showVideos: true,
  },
  "recursive subtree": {
    currentPath: "alpha",
    recursive: true,
    showImages: true,
    showVideos: true,
  },
  search: {
    currentPath: "",
    query: FIXTURE_SEARCH_TERM,
    recursive: false,
    showImages: true,
    showVideos: true,
  },
  "images only": { currentPath: "alpha", recursive: true, showImages: true, showVideos: false },
  "videos only": { currentPath: "", recursive: true, showImages: false, showVideos: true },
};

const COMIC_SHAPES: Record<string, Omit<OracleComicRequest, "randomSeed" | "sortMode">> = {
  "alpha subtree": { currentPath: "alpha", showImages: true, showVideos: true },
  "beta subtree": { currentPath: "beta", showImages: true, showVideos: true },
  "search from root": {
    currentPath: "",
    query: FIXTURE_SEARCH_TERM,
    showImages: true,
    showVideos: true,
  },
  "images hidden": { currentPath: "alpha", showImages: false, showVideos: true },
  "videos hidden": { currentPath: "alpha", showImages: true, showVideos: false },
};

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

describe("fixture", () => {
  it("has the row counts the oracle assumes", async () => {
    const rows = (
      await harness.handle?.client.query(
        "select count(*)::int as n from library_entries where deleted_at is null",
      )
    )?.rows as { n: number }[];
    expect(rows[0]?.n).toBe(liveEntries.length);
    expect(liveEntries.length).toBeGreaterThanOrEqual(1200);
  });
});

// ---------------------------------------------------------------------------
// Natural collation
// ---------------------------------------------------------------------------

describe("natural collation", () => {
  it("orders the fixture filenames exactly as the client collator does", async () => {
    const rows = (
      await harness.handle?.client.query(
        'select id from library_entries order by filename collate "natural", id',
      )
    )?.rows as { id: string }[];
    const expected = [...fixture.entries]
      .sort((a, b) => natural(nameOf(a.path), nameOf(b.path)) || bytes(a.id, b.id))
      .map((entry) => entry.id);
    expect(rows.map((row) => row.id)).toEqual(expected);
  });

  it("puts 2.jpg before 10.jpg and ties a.jpg with A.jpg at primary strength", async () => {
    const rows = (
      await harness.handle?.client.query(
        "select filename from library_entries where parent_path in ('alpha/comic-unpadded', 'alpha/case-tie') " +
          'order by filename collate "natural", id',
      )
    )?.rows as { filename: string }[];
    expect(rows.map((row) => row.filename)).toEqual([
      "2.jpg",
      "3.jpg",
      "4.jpg",
      "5.jpg",
      "6.jpg",
      "7.jpg",
      "8.jpg",
      "9.jpg",
      "10.jpg",
      "11.jpg",
      "12.jpg",
      "A.jpg",
      "a.jpg",
      "b.jpg",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Media listing
// ---------------------------------------------------------------------------

describe("media listing follows one seeded order across pages", () => {
  const cases = Object.entries(MEDIA_SHAPES).flatMap(([label, shape]) =>
    SORT_MODES.flatMap((sortMode) =>
      (sortMode === "random" ? [SEED_A, SEED_B] : [SEED_A]).flatMap((randomSeed) =>
        [7, 48, 100].map((limit) => ({ label, limit, randomSeed, shape, sortMode })),
      ),
    ),
  );

  it.each(cases)("$label · $sortMode · limit $limit · seed $randomSeed", async ({
    limit,
    randomSeed,
    shape,
    sortMode,
  }) => {
    const request = { ...shape, randomSeed, sortMode };
    const pages = await collectMediaPages(request, limit);
    const ids = pages.flatMap((page) => page.media.map((item) => item.id));
    const expected = expectedMediaOrder(request);

    expect(expected.length).toBeGreaterThan(0);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of pages) {
      expect(page.subjectKind).toBe("media");
      expect(page.comics).toEqual([]);
      expect(page.media.length).toBeLessThanOrEqual(limit);
      expect(page.entries.filter((entry) => entry.kind === "media")).toHaveLength(
        page.media.length,
      );
    }
  });

  it("returns folder entries only on the first page of a non-recursive browse", async () => {
    const pages = await collectMediaPages(
      {
        ...MEDIA_SHAPES["non-recursive folder"],
        randomSeed: SEED_A,
        sortMode: "name-asc",
      } as OracleMediaRequest,
      7,
    );
    const firstFolders = pages[0]?.entries.filter((entry) => entry.kind === "folder") ?? [];
    expect(firstFolders.map((entry) => (entry.kind === "folder" ? entry.name : ""))).toEqual([
      "case-tie",
      "comic-padded",
      "comic-unpadded",
      "mixed",
      "orphaned-child",
      "series",
      "videos-only",
    ]);
    for (const page of pages.slice(1)) {
      expect(page.entries.some((entry) => entry.kind === "folder")).toBe(false);
    }
  });

  it("rejects a cursor issued under another seed and restarts from page 1", async () => {
    const shape = MEDIA_SHAPES["recursive subtree"] as Omit<
      OracleMediaRequest,
      "randomSeed" | "sortMode"
    >;
    const underA = await readDatabaseGalleryListing({
      ...shape,
      limit: 7,
      randomSeed: SEED_A,
      sortMode: "random",
    });
    expect(underA.page.cursor).not.toBeNull();

    const spliced = await readDatabaseGalleryListing({
      ...shape,
      cursor: underA.page.cursor as string,
      limit: 7,
      randomSeed: SEED_B,
      sortMode: "random",
    });
    const firstUnderB = await readDatabaseGalleryListing({
      ...shape,
      limit: 7,
      randomSeed: SEED_B,
      sortMode: "random",
    });
    expect(spliced.media.map((item) => item.id)).toEqual(firstUnderB.media.map((item) => item.id));
  });

  it("rejects a cursor issued under another sort mode", async () => {
    const shape = MEDIA_SHAPES["recursive subtree"] as Omit<
      OracleMediaRequest,
      "randomSeed" | "sortMode"
    >;
    const byName = await readDatabaseGalleryListing({
      ...shape,
      limit: 7,
      randomSeed: SEED_A,
      sortMode: "name-asc",
    });
    const spliced = await readDatabaseGalleryListing({
      ...shape,
      cursor: byName.page.cursor as string,
      limit: 7,
      randomSeed: SEED_A,
      sortMode: "date-newest",
    });
    const firstByDate = await readDatabaseGalleryListing({
      ...shape,
      limit: 7,
      randomSeed: SEED_A,
      sortMode: "date-newest",
    });
    expect(spliced.media.map((item) => item.id)).toEqual(firstByDate.media.map((item) => item.id));
  });

  it("filters do not reorder: the images-only random order is a subsequence of the unfiltered order", async () => {
    const base = {
      currentPath: "alpha",
      recursive: true,
      randomSeed: SEED_A,
      sortMode: "random" as const,
    };
    const all = (
      await collectMediaPages({ ...base, showImages: true, showVideos: true }, 48)
    ).flatMap((page) => page.media.map((item) => item.id));
    const images = (
      await collectMediaPages({ ...base, showImages: true, showVideos: false }, 48)
    ).flatMap((page) => page.media.map((item) => item.id));
    expect(images.length).toBeLessThan(all.length);
    expect(images).toEqual(all.filter((id) => images.includes(id)));
  });

  it("changes the whole permutation, first page included, when the seed changes", async () => {
    const shape = MEDIA_SHAPES["recursive subtree"] as Omit<
      OracleMediaRequest,
      "randomSeed" | "sortMode"
    >;
    const underA = await readDatabaseGalleryListing({
      ...shape,
      limit: 48,
      randomSeed: SEED_A,
      sortMode: "random",
    });
    const underB = await readDatabaseGalleryListing({
      ...shape,
      limit: 48,
      randomSeed: SEED_B,
      sortMode: "random",
    });
    expect(underA.media.map((item) => item.id)).not.toEqual(underB.media.map((item) => item.id));
  });
});

// ---------------------------------------------------------------------------
// Comic listing
// ---------------------------------------------------------------------------

describe("comic listing serves summaries in one seeded order across pages", () => {
  const cases = Object.entries(COMIC_SHAPES).flatMap(([label, shape]) =>
    SORT_MODES.flatMap((sortMode) =>
      (sortMode === "random" ? [SEED_A, SEED_B] : [SEED_A]).flatMap((randomSeed) =>
        [3, 7, 48].map((limit) => ({ label, limit, randomSeed, shape, sortMode })),
      ),
    ),
  );

  it.each(cases)("$label · $sortMode · limit $limit · seed $randomSeed", async ({
    label,
    limit,
    randomSeed,
    shape,
    sortMode,
  }) => {
    const request = { ...shape, randomSeed, sortMode };
    const pages = await collectComicPages(request, limit);
    const comics = pages.flatMap((page) => page.comics);
    const expected = expectedComicOrder(request);

    expect(expected.length).toBeGreaterThan(label === "images hidden" ? -1 : 0);
    expect(comics.map((comic) => comic.id)).toEqual(expected.map((comic) => comic.folderPath));
    expect(comics.map((comic) => comic.cover.id)).toEqual(expected.map((comic) => comic.cover.id));
    expect(comics.map((comic) => comic.pageCount)).toEqual(
      expected.map((comic) => comic.pageCount),
    );
    expect(pages[0]?.comics.map((comic) => comic.id)).toEqual(
      expected.slice(0, limit).map((comic) => comic.folderPath),
    );
    for (const page of pages) {
      expect(page.subjectKind).toBe("comic");
      expect(page.entries).toEqual([]);
      expect(page.media.map((item) => item.id)).toEqual(page.comics.map((comic) => comic.cover.id));
      for (const comic of page.comics) {
        expect(comic).not.toHaveProperty("pages");
        expect(comic.folderPath).toBe(comic.id);
      }
    }
  });

  it("applies the eligibility rules: root media, parents, video-only and deleted folders never form comics", async () => {
    const request = {
      ...COMIC_SHAPES["alpha subtree"],
      randomSeed: SEED_A,
      sortMode: "name-asc" as const,
    } as OracleComicRequest;
    const ids = (await collectComicPages(request, 48)).flatMap((page) =>
      page.comics.map((comic) => comic.id),
    );
    expect(ids).toEqual([
      "alpha/case-tie",
      "alpha/comic-padded",
      "alpha/comic-unpadded",
      "alpha/mixed",
      "alpha/orphaned-child",
      "alpha/series/vol-1",
      "alpha/series/vol-2",
    ]);
    expect(ids).not.toContain("alpha"); // media directly under the browse root
    expect(ids).not.toContain("alpha/series"); // has live child folders
    expect(ids).not.toContain("alpha/videos-only"); // no image or gif page

    const gamma = (await collectComicPages({ ...request, currentPath: "gamma" }, 48)).flatMap(
      (page) => page.comics,
    );
    expect(gamma.map((comic) => comic.id)).toEqual([
      "gamma/empty-parent/deep",
      "gamma/heroes",
      "gamma/one-deleted",
    ]);
    expect(gamma.find((comic) => comic.id === "gamma/one-deleted")?.pageCount).toBe(4);
  });

  it("chooses the natural minimum as cover, agreeing with compareByName", async () => {
    const request = {
      ...COMIC_SHAPES["alpha subtree"],
      randomSeed: SEED_A,
      sortMode: "name-asc" as const,
    } as OracleComicRequest;
    const comics = (await collectComicPages(request, 48)).flatMap((page) => page.comics);
    const coverName = (id: string) => comics.find((comic) => comic.id === id)?.cover.name;
    expect(coverName("alpha/comic-unpadded")).toBe("2.jpg");
    expect(coverName("alpha/comic-padded")).toBe("001.jpg");
    expect(coverName("alpha/mixed")).toBe("still-1.jpg");
    expect(coverName("alpha/series/vol-1")).toBe("bonus.gif");
    // Primary-equal names tie in the collation; the deterministic collation breaks the tie bytewise.
    expect(coverName("alpha/case-tie")).toBe("A.jpg");
  });

  it("counts only pages that match the search and lists only comics with a matching page", async () => {
    const request = {
      ...COMIC_SHAPES["search from root"],
      randomSeed: SEED_A,
      sortMode: "name-asc" as const,
    } as OracleComicRequest;
    const comics = (await collectComicPages(request, 48)).flatMap((page) => page.comics);
    const heroes = comics.find((comic) => comic.id === "gamma/heroes");
    expect(heroes?.pageCount).toBe(10); // the folder path matches, so every page does
    const set = comics.find((comic) => comic.id === "beta/set-009");
    expect(set?.pageCount).toBe(1); // only hero-3.jpg matches
    expect(comics.some((comic) => comic.id === "beta/set-001")).toBe(false);
  });

  it("rejects a comic cursor issued under another seed or for media", async () => {
    const shape = COMIC_SHAPES["beta subtree"] as Omit<
      OracleComicRequest,
      "randomSeed" | "sortMode"
    >;
    const underA = await readDatabaseComicListing({
      ...shape,
      limit: 7,
      randomSeed: SEED_A,
      sortMode: "random",
    });
    const spliced = await readDatabaseComicListing({
      ...shape,
      cursor: underA.page.cursor as string,
      limit: 7,
      randomSeed: SEED_B,
      sortMode: "random",
    });
    const firstUnderB = await readDatabaseComicListing({
      ...shape,
      limit: 7,
      randomSeed: SEED_B,
      sortMode: "random",
    });
    expect(spliced.comics.map((comic) => comic.id)).toEqual(
      firstUnderB.comics.map((comic) => comic.id),
    );

    const mediaCursor = (
      await readDatabaseGalleryListing({
        ...shape,
        limit: 7,
        randomSeed: SEED_A,
        recursive: true,
        sortMode: "random",
      })
    ).page.cursor as string;
    const acrossKinds = await readDatabaseComicListing({
      ...shape,
      cursor: mediaCursor,
      limit: 7,
      randomSeed: SEED_A,
      sortMode: "random",
    });
    expect(acrossKinds.comics.map((comic) => comic.id)).toEqual(
      underA.comics.map((comic) => comic.id),
    );
  });
});

// ---------------------------------------------------------------------------
// Comic by id
// ---------------------------------------------------------------------------

describe("readDatabaseGalleryComic", () => {
  const request = { currentPath: "alpha", showImages: true, showVideos: true };

  function fixtureItems(currentPath: string) {
    return liveEntries
      .filter((entry) => entry.path.startsWith(`${currentPath}/`))
      .map((entry) => ({
        id: entry.id,
        mediaType: entry.mediaType as MediaType,
        mtimeMs: entry.mtimeMs,
        name: nameOf(entry.path),
        path: entry.path,
      }));
  }

  it("resolves every fixture comic with the page order the client grouping produced", async () => {
    const grouped = buildComicEntries(fixtureItems("alpha"), "alpha", {
      folders: liveFolders.map((folder) => ({ parentPath: parentPathOf(folder.path) })),
      leafFoldersOnly: true,
    });
    expect(grouped.length).toBe(7);

    for (const expected of grouped) {
      const comic = await readDatabaseGalleryComic({ ...request, comicId: expected.id });
      expect(comic).not.toBeNull();
      expect(comic?.name).toBe(expected.name);
      expect(comic?.cover.id).toBe(comic?.pages[0]?.id);
      if (expected.id === "alpha/case-tie") {
        // compareByName ties a.jpg with A.jpg and buildComicEntries keeps
        // insertion order; the server breaks the tie bytewise so the reader's
        // first page is the card's cover.
        expect(comic?.pages.map((page) => page.name)).toEqual(["A.jpg", "a.jpg", "b.jpg"]);
        expect(expected.pages.map((page) => page.name)).toEqual(["a.jpg", "A.jpg", "b.jpg"]);
        continue;
      }
      expect(comic?.pages.map((page) => page.id)).toEqual(expected.pages.map((page) => page.id));
    }
  });

  it("returns only pages matching the search and honours visibility", async () => {
    const searched = await readDatabaseGalleryComic({
      comicId: "beta/set-009",
      currentPath: "beta",
      query: FIXTURE_SEARCH_TERM,
      showImages: true,
      showVideos: true,
    });
    expect(searched?.pages.map((page) => page.name)).toEqual(["hero-3.jpg"]);

    const hidden = await readDatabaseGalleryComic({
      ...request,
      comicId: "alpha/comic-padded",
      showImages: false,
    });
    expect(hidden).toBeNull();
  });

  it("rejects a comic outside the browse scope, the scope itself, and non-comic folders", async () => {
    expect(await readDatabaseGalleryComic({ ...request, comicId: "beta/set-001" })).toBeNull();
    expect(await readDatabaseGalleryComic({ ...request, comicId: "alpha" })).toBeNull();
    expect(await readDatabaseGalleryComic({ ...request, comicId: "alpha/series" })).toBeNull();
    expect(await readDatabaseGalleryComic({ ...request, comicId: "alpha/videos-only" })).toBeNull();
    expect(
      await readDatabaseGalleryComic({ ...request, comicId: "alpha/comic-paddedx" }),
    ).toBeNull();
  });
});
