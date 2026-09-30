import { describe, expect, it } from "vitest";
import { testDatabaseForSuite } from "../library/test-db";
import { libraryEntries, mediaObjects, shutterSourceCleanup } from "./schema";

/**
 * Hashes are compared as text (the purge queue against media rows, a sync
 * against the queue), so the archive holds one spelling per hash: lowercase.
 * Migration 0021 enforces it with CHECK constraints; these run that SQL.
 */

const testDatabase = testDatabaseForSuite();

const lowercaseHash = "ab".repeat(32);

const uppercaseHash = lowercaseHash.toUpperCase();

function mediaObject(sha256: string) {
  return {
    contentType: "image/jpeg",
    extension: "jpg",
    mediaType: "image" as const,
    objectKey: `originals/sha256/ab/ab/${lowercaseHash}.jpg`,
    sha256,
    size: 1024,
  };
}

function violating(constraint: string) {
  return { cause: expect.objectContaining({ constraint }) };
}

describe("sha256 columns", () => {
  it("reject a media object hash that is not lowercase", async () => {
    const { db } = testDatabase();

    await expect(db.insert(mediaObjects).values(mediaObject(uppercaseHash))).rejects.toMatchObject(
      violating("media_objects_sha256_lowercase"),
    );
  });

  it("reject a queued Shutter source hash that is not lowercase", async () => {
    const { db } = testDatabase();

    await expect(
      db.insert(shutterSourceCleanup).values({ sha256: uppercaseHash }),
    ).rejects.toMatchObject(violating("shutter_source_cleanup_sha256_lowercase"));
  });

  it("reject a library entry hash that is not lowercase", async () => {
    const { db } = testDatabase();

    const [media] = await db
      .insert(mediaObjects)
      .values(mediaObject(lowercaseHash))
      .returning({ id: mediaObjects.id });

    if (!media) throw new Error("failed to insert media object");

    const entry = {
      filename: "photo.jpg",
      logicalPath: "photo.jpg",
      mediaObjectId: media.id,
      mtimeMs: 1_700_000_000_000,
    };

    await expect(
      db.insert(libraryEntries).values({ ...entry, sha256: uppercaseHash }),
    ).rejects.toMatchObject(violating("library_entries_sha256_lowercase"));
    await db.insert(libraryEntries).values({ ...entry, sha256: lowercaseHash });
    await db.insert(shutterSourceCleanup).values({ sha256: lowercaseHash });
  });
});
