import { type GallerySortMode, GallerySortModeSchema } from "@latch-works/media-domain";
import { describe, expect, it } from "vitest";
import { libraryEntries, mediaObjects } from "../db/schema";
import { readDatabaseComicListing } from "./comic-listing";
import type { GalleryListingPage } from "./gallery-listing";
import {
  type GalleryRandomSeed,
  galleryRandomOrderKey,
  galleryRandomOrderKeySql,
} from "./gallery-order";
import { readDatabaseGalleryListing } from "./repository";
import { type TestDatabase, testDatabaseForSuite } from "./test-db";

const randomSeed: GalleryRandomSeed = "0123456789abcdef0123456789abcdef";

/**
 * Names the natural collation and a bytewise order disagree on ("2" before
 * "10", case ignored), repeated across folders so filename ties fall through
 * to the path, and mtimes shared in threes so date ties fall through too.
 */
const names = ["10.jpg", "2.jpg", "a.jpg", "B.jpg", "b.jpg", "Cover.jpg"];

const comicFolders = ["series/10", "series/2", "series/a", "series/B", "Series/c", "extra/one"];

async function seed(database: TestDatabase): Promise<void> {
  let index = 0;

  for (const folder of comicFolders) {
    for (const name of names) {
      index += 1;
      const sha256 = index.toString(16).padStart(64, "0");

      const [object] = await database
        .insert(mediaObjects)
        .values({
          contentType: "image/jpeg",
          extension: "jpg",
          mediaType: "image",
          objectKey: `originals/${sha256}.jpg`,
          sha256,
          size: 1024,
        })
        .returning({ id: mediaObjects.id });

      if (!object) throw new Error("failed to insert media object");

      await database.insert(libraryEntries).values({
        filename: name,
        logicalPath: `${folder}/${name}`,
        mediaObjectId: object.id,
        mtimeMs: 1_700_000_000_000 + Math.floor(index / 3) * 1_000,
        parentPath: folder,
        size: 1024,
      });
    }
  }
}

const testDatabase = testDatabaseForSuite(seed);

/**
 * The order each sort mode promises, computed in JS from the seeded rows
 * rather than read back from the query: natural, case-insensitive names
 * (what the ICU `natural` collation does, bytes breaking its ties), dates tie-broken by path, and the
 * seeded random key. Ids end every order so it is total.
 */
const naturalCollator = new Intl.Collator("und", { numeric: true, sensitivity: "base" });

interface SeededRow {
  filename: string;
  id: string;
  logicalPath: string;
  mtimeMs: number;
}

function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The `natural` collation is deterministic, so Postgres breaks its
 * case-insensitive ties ("B.jpg" and "b.jpg") by byte order.
 */
function naturalOrder(left: string, right: string): number {
  return naturalCollator.compare(left, right) || byteOrder(left, right);
}

function expectedMediaOrder(sortMode: GallerySortMode, rows: SeededRow[]): string[] {
  const compare = (left: SeededRow, right: SeededRow): number => {
    switch (sortMode) {
      case "name-asc":
      case "name-desc": {
        const sign = sortMode === "name-asc" ? 1 : -1;

        return (
          sign *
          (naturalOrder(left.filename, right.filename) ||
            naturalOrder(left.logicalPath, right.logicalPath) ||
            byteOrder(left.id, right.id))
        );
      }

      case "date-newest":
      case "date-oldest": {
        const sign = sortMode === "date-oldest" ? 1 : -1;

        return (
          sign * (left.mtimeMs - right.mtimeMs) ||
          byteOrder(left.logicalPath, right.logicalPath) ||
          byteOrder(left.id, right.id)
        );
      }

      case "random":
        return (
          byteOrder(
            galleryRandomOrderKey(randomSeed, "media", left.id),
            galleryRandomOrderKey(randomSeed, "media", right.id),
          ) ||
          byteOrder(left.logicalPath, right.logicalPath) ||
          byteOrder(left.id, right.id)
        );
    }
  };

  return [...rows].sort(compare).map((row) => row.logicalPath);
}

/** Every page of a listing, `limit` rows at a time, following the cursor. */
async function readAllPages(
  readPage: (cursor: string | undefined) => Promise<GalleryListingPage>,
): Promise<GalleryListingPage[]> {
  const pages: GalleryListingPage[] = [];
  let cursor: string | undefined;

  do {
    const page = await readPage(cursor);
    pages.push(page);
    cursor = page.page.cursor ?? undefined;
  } while (cursor);

  return pages;
}

describe("gallery keyset paging", () => {
  for (const sortMode of GallerySortModeSchema.options) {
    it(`media pages follow the ${sortMode} order without skipping or repeating an entry`, async () => {
      const read = (limit: number, cursor?: string) =>
        readDatabaseGalleryListing(
          {
            currentPath: "",
            cursor,
            limit,
            randomSeed,
            recursive: true,
            showImages: true,
            showVideos: true,
            sortMode,
          },
          testDatabase().db,
        );

      const whole = (await read(200)).media.map((item) => item.path);
      const pages = await readAllPages((cursor) => read(4, cursor));

      const seeded = await testDatabase()
        .db.select({
          filename: libraryEntries.filename,
          id: libraryEntries.id,
          logicalPath: libraryEntries.logicalPath,
          mtimeMs: libraryEntries.mtimeMs,
        })
        .from(libraryEntries);

      expect(whole).toEqual(expectedMediaOrder(sortMode, seeded));
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.flatMap((page) => page.media.map((item) => item.path))).toEqual(whole);
    });

    it(`comic pages in ${sortMode} order neither skip nor repeat a comic`, async () => {
      const read = (limit: number, cursor?: string) =>
        readDatabaseComicListing(
          {
            currentPath: "",
            cursor,
            limit,
            randomSeed,
            showImages: true,
            showVideos: true,
            sortMode,
          },
          testDatabase().db,
        );

      const whole = (await read(200)).comics.map((comic) => comic.id);
      const pages = await readAllPages((cursor) => read(2, cursor));

      expect([...whole].sort()).toEqual([...comicFolders].sort());
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.flatMap((page) => page.comics.map((comic) => comic.id))).toEqual(whole);
    });
  }

  it("computes the same random rank in SQL as in JS", async () => {
    const { db } = testDatabase();

    const rows = await db
      .select({
        comicKey: galleryRandomOrderKeySql(randomSeed, "comic", libraryEntries.parentPath),
        id: libraryEntries.id,
        mediaKey: galleryRandomOrderKeySql(randomSeed, "media", libraryEntries.id),
        parentPath: libraryEntries.parentPath,
      })
      .from(libraryEntries);

    expect(rows).toHaveLength(names.length * comicFolders.length);

    for (const row of rows) {
      expect(row.mediaKey).toBe(galleryRandomOrderKey(randomSeed, "media", row.id));
      expect(row.comicKey).toBe(galleryRandomOrderKey(randomSeed, "comic", row.parentPath));
    }
  });
});
