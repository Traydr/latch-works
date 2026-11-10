import { isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { initialProgressFor } from "@/lib/library-jobs";
import { folders, libraryEntries, maintenanceJobs, mediaObjects, syncRuns } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import {
  countEntriesUnderPaths,
  type FolderDeleteResult,
  softDeleteFolderSubtree,
} from "./folder-delete";

const testDatabase = testDatabaseForSuite();

async function seedFolders(): Promise<void> {
  const { db } = testDatabase();

  const [object] = await db
    .insert(mediaObjects)
    .values({
      contentType: "image/jpeg",
      extension: "jpg",
      mediaType: "image",
      objectKey: "originals/seed.jpg",
      sha256: "a".repeat(64),
      size: 1024,
    })
    .returning({ id: mediaObjects.id });

  if (!object) throw new Error("failed to insert media object");

  for (const path of ["photos", "photos/2026", "photos/2025"]) {
    await db.insert(folders).values({ name: path.split("/").at(-1) ?? path, path });
  }

  for (const parentPath of ["photos/2026", "photos/2025"]) {
    await db.insert(libraryEntries).values({
      filename: "seed.jpg",
      logicalPath: `${parentPath}/seed.jpg`,
      mediaObjectId: object.id,
      mtimeMs: 1_700_000_000_000,
      parentPath,
    });
  }
}

async function liveEntryPaths(): Promise<string[]> {
  const { db } = testDatabase();

  const rows = await db
    .select({ logicalPath: libraryEntries.logicalPath })
    .from(libraryEntries)
    .where(isNull(libraryEntries.deletedAt));

  return rows.map((row) => row.logicalPath).sort();
}

async function liveFolderPaths(): Promise<string[]> {
  const { db } = testDatabase();

  const rows = await db
    .select({ path: folders.path })
    .from(folders)
    .where(isNull(folders.deletedAt));

  return rows.map((row) => row.path).sort();
}

describe("softDeleteFolderSubtree", () => {
  beforeEach(async () => {
    const { client, db } = testDatabase();
    await client.exec("drop trigger if exists fail_folder_update_trigger on folders;");
    await db.delete(libraryEntries);
    await db.delete(folders);
    await db.delete(mediaObjects);
    await db.delete(maintenanceJobs);
    await db.delete(syncRuns);
  });

  it("rejects deleting the archive root", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [""] }, testDatabase().db)).rejects.toThrow(
      "Cannot delete the archive root",
    );
  });

  it("rejects folder paths with parent segments", async () => {
    await expect(
      softDeleteFolderSubtree({ folderPaths: ["photos/../other"] }, testDatabase().db),
    ).rejects.toThrow("Folder path must not contain '..' segments.");
  });

  it("rejects empty folder selection", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [] }, testDatabase().db)).rejects.toThrow(
      "Select at least one folder",
    );
  });

  it("refuses to delete while a cleanup job is active, before touching any row", async () => {
    const { db } = testDatabase();
    await seedFolders();
    await db.insert(maintenanceJobs).values({
      progress: initialProgressFor("soft_deleted_purge"),
      status: "running",
      type: "soft_deleted_purge",
    });

    await expect(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, testDatabase().db),
    ).rejects.toThrow("cleanup job is still running");
    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });

  it("refuses to delete while a sync run is active", async () => {
    const { db } = testDatabase();
    await seedFolders();
    await db.insert(syncRuns).values({ sourceRoot: "/archive", status: "running" });

    await expect(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, testDatabase().db),
    ).rejects.toThrow("sync run is currently active");
    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });

  it("soft-deletes entries and folders in one transaction", async () => {
    await seedFolders();

    const results = await softDeleteFolderSubtree(
      { folderPaths: ["photos/2026/", "photos/2026", "photos/2025"] },
      testDatabase().db,
    );

    expect(results).toEqual([
      { entriesDeleted: 1, foldersDeleted: 1, path: "photos/2026" },
      { entriesDeleted: 1, foldersDeleted: 1, path: "photos/2025" },
    ]);
    expect(await liveEntryPaths()).toEqual([]);
    expect(await liveFolderPaths()).toEqual(["photos"]);

    const { db } = testDatabase();
    const stamps = await db.select({ deletedAt: libraryEntries.deletedAt }).from(libraryEntries);
    const folderStamps = await db.select({ deletedAt: folders.deletedAt }).from(folders);
    const deletedAt = stamps[0]?.deletedAt;
    expect(deletedAt).toBeInstanceOf(Date);

    // One `now` for the whole call: every row carries the same instant.
    for (const row of [...stamps, ...folderStamps.filter((row) => row.deletedAt !== null)]) {
      expect(row.deletedAt).toEqual(deletedAt);
    }
  });

  it("leaves a folder whose path differs only in case alone", async () => {
    const { db } = testDatabase();
    await seedFolders();
    const [object] = await db.select({ id: mediaObjects.id }).from(mediaObjects);

    if (!object) throw new Error("seed media object missing");

    await db.insert(folders).values([
      { name: "Photos", path: "Photos" },
      { name: "2026", parentPath: "Photos", path: "Photos/2026" },
    ]);
    await db.insert(libraryEntries).values({
      filename: "seed.jpg",
      logicalPath: "Photos/2026/seed.jpg",
      mediaObjectId: object.id,
      mtimeMs: 1_700_000_000_000,
      parentPath: "Photos/2026",
    });

    expect(await countEntriesUnderPaths(["photos", "photos/2026"], db)).toBe(2);

    const results = await softDeleteFolderSubtree({ folderPaths: ["photos"] }, testDatabase().db);

    expect(results).toEqual([{ entriesDeleted: 2, foldersDeleted: 3, path: "photos" }]);
    expect(await liveEntryPaths()).toEqual(["Photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["Photos", "Photos/2026"]);
  });

  it("rolls back when the folder update fails", async () => {
    await seedFolders();
    await failFolderUpdates("photos/2026", "folder update failed");

    await expectFailure(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, testDatabase().db),
      "folder update failed",
    );

    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });

  it("rolls back all roots when a later folder update fails", async () => {
    await seedFolders();
    await failFolderUpdates("photos/2025", "second root folder update failed");

    await expectFailure(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026", "photos/2025"] }, testDatabase().db),
      "second root folder update failed",
    );

    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });
});

/**
 * Makes the folders update raise for one path, so the rollback is the real
 * transaction's, not a stub's. `beforeEach` drops the trigger again.
 */
async function failFolderUpdates(path: string, message: string): Promise<void> {
  const { client } = testDatabase();
  await client.exec(`
    create or replace function fail_folder_update() returns trigger as $$
      begin raise exception '${message}'; end;
    $$ language plpgsql;
    drop trigger if exists fail_folder_update_trigger on folders;
    create trigger fail_folder_update_trigger before update on folders
      for each row when (old.path = '${path}') execute function fail_folder_update();
  `);
}

/** Drizzle reports the raise as the `cause` of its own "Failed query" error. */
async function expectFailure(work: Promise<FolderDeleteResult[]>, message: string): Promise<void> {
  let thrown: Error | null = null;

  try {
    await work;
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  }

  expect(thrown).not.toBeNull();
  const cause = thrown?.cause;
  expect(cause instanceof Error ? cause.message : (thrown?.message ?? "")).toContain(message);
}
