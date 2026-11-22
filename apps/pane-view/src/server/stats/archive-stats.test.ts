import { eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { libraryEntries, librarySizeEvents, mediaObjects } from "../db/schema";
import { type TestDatabase, testDatabaseForSuite } from "../library/test-db";
import { readArchiveStats } from "./archive-stats";

/**
 * The size ledger against executed SQL: migration 0023's trigger writes every
 * row, so these tests change library entries the way any write path would and
 * read what the trigger recorded.
 */

const testDatabase = testDatabaseForSuite();

async function insertObject(database: TestDatabase, name: string, size: number): Promise<string> {
  const [row] = await database
    .insert(mediaObjects)
    .values({
      contentType: "video/mp4",
      extension: "mp4",
      mediaType: "video",
      objectKey: `objects/${name}`,
      sha256: name.padEnd(64, "0"),
      size,
    })
    .returning({ id: mediaObjects.id });

  if (!row) throw new Error("failed to insert media object");

  return row.id;
}

async function ledgerSum(database: TestDatabase): Promise<number> {
  const [row] = await database
    .select({ bytes: sql`coalesce(sum(${librarySizeEvents.bytesDelta}), 0)`.mapWith(Number) })
    .from(librarySizeEvents);

  return row?.bytes ?? 0;
}

async function liveEntryBytes(database: TestDatabase): Promise<number> {
  const [row] = await database
    .select({ bytes: sql`coalesce(sum(${mediaObjects.size}), 0)`.mapWith(Number) })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(mediaObjects.id, libraryEntries.mediaObjectId))
    .where(isNull(libraryEntries.deletedAt));

  return row?.bytes ?? 0;
}

describe("library size ledger", () => {
  beforeEach(async () => {
    const { db } = testDatabase();
    await db.delete(libraryEntries);
    await db.delete(mediaObjects);
    await db.delete(librarySizeEvents);
  });

  it("sums to the size of live entries through every kind of change", async () => {
    const { db } = testDatabase();
    const h264 = await insertObject(db, "a1", 9000);
    const av1 = await insertObject(db, "b2", 3000);
    const photo = await insertObject(db, "c3", 500);

    async function setDeletedAt(logicalPath: string, deletedAt: Date | null): Promise<void> {
      await db
        .update(libraryEntries)
        .set({ deletedAt })
        .where(eq(libraryEntries.logicalPath, logicalPath));
      expect(await ledgerSum(db)).toBe(await liveEntryBytes(db));
    }

    await db.insert(libraryEntries).values([
      { filename: "v.mp4", logicalPath: "v.mp4", mediaObjectId: h264, mtimeMs: 1 },
      { filename: "p.mp4", logicalPath: "p.mp4", mediaObjectId: photo, mtimeMs: 1 },
    ]);
    expect(await ledgerSum(db)).toBe(9500);

    await db
      .update(libraryEntries)
      .set({ mediaObjectId: av1 })
      .where(eq(libraryEntries.logicalPath, "v.mp4"));
    expect(await ledgerSum(db)).toBe(await liveEntryBytes(db));

    await setDeletedAt("p.mp4", new Date());
    // A second soft delete of the same entry changes nothing.
    await setDeletedAt("p.mp4", new Date());
    await setDeletedAt("p.mp4", null);

    await db.delete(libraryEntries).where(eq(libraryEntries.logicalPath, "p.mp4"));
    expect(await ledgerSum(db)).toBe(await liveEntryBytes(db));

    const events = await db
      .select({ bytesDelta: librarySizeEvents.bytesDelta, kind: librarySizeEvents.kind })
      .from(librarySizeEvents)
      .orderBy(librarySizeEvents.id);

    expect(events).toEqual([
      { bytesDelta: 9000, kind: "added" },
      { bytesDelta: 500, kind: "added" },
      { bytesDelta: -6000, kind: "replaced" },
      { bytesDelta: -500, kind: "removed" },
      { bytesDelta: 500, kind: "restored" },
      { bytesDelta: -500, kind: "removed" },
    ]);
  });

  it("shows a re-encode as a drop in the stats", async () => {
    const { db } = testDatabase();
    const h264 = await insertObject(db, "a1", 9000);
    const av1 = await insertObject(db, "b2", 3000);
    await db
      .insert(libraryEntries)
      .values({ filename: "v.mp4", logicalPath: "v.mp4", mediaObjectId: h264, mtimeMs: 1 });
    await db.update(librarySizeEvents).set({ occurredAt: sql`now() - interval '3 days'` });

    await db
      .update(libraryEntries)
      .set({ mediaObjectId: av1 })
      .where(eq(libraryEntries.logicalPath, "v.mp4"));

    const stats = await readArchiveStats(db);

    expect(stats.recentGrowth.at(-1)?.netBytes).toBe(-6000);
    expect(stats.recentGrowth.at(-4)?.netBytes).toBe(9000);
    expect(stats.sizeOverTime.at(-1)?.value).toBe(3000);
    expect(stats.growth.bytesLast30Days).toBe(3000);
  });
});
