import { isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { folders, libraryEntries, maintenanceJobs, mediaObjects, syncRuns } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import {
  type FolderDeleteDependencies,
  type FolderDeleteResult,
  softDeleteFolderSubtree,
} from "./folder-delete";
import { assertNoActiveCleanupJob, assertNoActiveSyncRun } from "./guards";
import { initialProgressFor } from "./maintenance-progress";

const testDatabase = testDatabaseForSuite();

/** The prologue collaborators, recording the transaction each one is handed. */
interface RecordedPrologue {
  calls: string[];
  transactions: Database[];
}

function dependencies(recorded: RecordedPrologue): FolderDeleteDependencies {
  return {
    acquireLibraryMutationStartupLock: async (tx) => {
      recorded.calls.push("lock");
      recorded.transactions.push(tx);
    },
    assertNoActiveCleanupJob: async (tx) => {
      recorded.calls.push("cleanup-guard");
      recorded.transactions.push(tx);
    },
    assertNoActiveSyncRun: async (tx) => {
      recorded.calls.push("sync-guard");
      recorded.transactions.push(tx);
    },
    database: testDatabase().db,
  };
}

/** The real prologue, so the guards read the rows this suite inserts. */
function realDependencies(): FolderDeleteDependencies {
  return {
    acquireLibraryMutationStartupLock,
    assertNoActiveCleanupJob,
    assertNoActiveSyncRun,
    database: testDatabase().db,
  };
}

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
      size: 1024,
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
    await expect(
      softDeleteFolderSubtree({ folderPaths: [""] }, realDependencies()),
    ).rejects.toThrow("Cannot delete the archive root");
  });

  it("rejects folder paths with parent segments", async () => {
    await expect(
      softDeleteFolderSubtree({ folderPaths: ["photos/../other"] }, realDependencies()),
    ).rejects.toThrow("Folder path must not contain '..' segments.");
  });

  it("rejects empty folder selection", async () => {
    await expect(softDeleteFolderSubtree({ folderPaths: [] }, realDependencies())).rejects.toThrow(
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
      softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, realDependencies()),
    ).rejects.toThrow("cleanup job is still running");
    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });

  it("refuses to delete while a sync run is active", async () => {
    const { db } = testDatabase();
    await seedFolders();
    await db.insert(syncRuns).values({ sourceRoot: "/archive", status: "running" });

    await expect(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, realDependencies()),
    ).rejects.toThrow("sync run is currently active");
    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });

  it("takes the library mutation lock and runs both guards on the mutation transaction", async () => {
    await seedFolders();
    const recorded: RecordedPrologue = { calls: [], transactions: [] };

    await softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, dependencies(recorded));

    // Lock, then the sync guard, then the cleanup guard, all on one transaction.
    expect(recorded.calls).toEqual(["lock", "sync-guard", "cleanup-guard"]);
    const [lockTx] = recorded.transactions;
    expect(lockTx).toBeDefined();
    expect(lockTx).not.toBe(testDatabase().db);
    expect(recorded.transactions).toEqual([lockTx, lockTx, lockTx]);
  });

  it("soft-deletes entries and folders in one transaction", async () => {
    await seedFolders();
    const recorded: RecordedPrologue = { calls: [], transactions: [] };

    const results = await softDeleteFolderSubtree(
      { folderPaths: ["photos/2026/", "photos/2026", "photos/2025"] },
      dependencies(recorded),
    );

    expect(results).toEqual([
      { entriesDeleted: 1, foldersDeleted: 1, path: "photos/2026" },
      { entriesDeleted: 1, foldersDeleted: 1, path: "photos/2025" },
    ]);
    // The prologue runs once, however many roots the selection names.
    expect(recorded.calls).toEqual(["lock", "sync-guard", "cleanup-guard"]);
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

  it("rolls back when the folder update fails", async () => {
    await seedFolders();
    await failFolderUpdates("photos/2026", "folder update failed");

    await expectFailure(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026"] }, realDependencies()),
      "folder update failed",
    );

    expect(await liveEntryPaths()).toEqual(["photos/2025/seed.jpg", "photos/2026/seed.jpg"]);
    expect(await liveFolderPaths()).toEqual(["photos", "photos/2025", "photos/2026"]);
  });

  it("rolls back all roots when a later folder update fails", async () => {
    await seedFolders();
    await failFolderUpdates("photos/2025", "second root folder update failed");

    await expectFailure(
      softDeleteFolderSubtree({ folderPaths: ["photos/2026", "photos/2025"] }, realDependencies()),
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
